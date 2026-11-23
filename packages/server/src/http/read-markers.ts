/**
 * Read-marker router (read/unread tracking — a provider-local extension). Two
 * signed endpoints, mounted at `/api/me`, mirroring the privacy/presence shape:
 *
 *  - `GET  /api/me/read-markers` — the caller's full unread summary: one entry
 *    per scope (visible channel + DM inbox conversation) with `{ scopeId,
 *    lastReadSeq, unreadCount }`.
 *  - `PATCH /api/me/read-markers` — advance one or many markers. Markers are
 *    monotonic (a backward value is ignored). After persisting, a `read.updated`
 *    event is fanned to the actor's OTHER devices via `hub.publishToActor` for
 *    multi-device sync. Returns the touched markers with recomputed unread counts.
 *
 * Read state is private + per-account. A marker on a scope the caller can't
 * currently read (or a DM not in its inbox) is silently ignored, exactly like an
 * unknown scope — never 403/404'd, so the response can't confirm a scope or
 * message exists. The PATCH is idempotent.
 */
import {
  ReadMarkersResponseSchema,
  ReadMarkersUpdateRequestSchema,
  canonicalAuthority,
} from "@forumall/shared";
import { Hono } from "hono";

import { getUserRow } from "../provider/guests.ts";
import {
  canHoldMarker,
  getUnreadSummary,
  seqForMessage,
  setReadMarkers,
  unreadEntryFor,
} from "../provider/read-markers.ts";
import { AppError } from "./errors.ts";
import { requireLocalActor, requireLocalHandle, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/**
 * The caller-facing read-marker router. Mounted at `/api/me`, so it serves
 * `/api/me/read-markers`.
 */
export function createMeReadMarkersRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  // Read state is private + per-LOCAL-account, keyed on the caller's handle.
  const local = requireLocalActor();

  // -- GET /api/me/read-markers (signed) ----------------------------------
  router.get("/read-markers", signed, local, (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const handle = requireLocalHandle(c);
    const scopes = getUnreadSummary(db, handle, `${handle}@${canonicalAuthority(config.domain)}`);
    return c.json(ReadMarkersResponseSchema.parse({ scopes }), 200);
  });

  // -- PATCH /api/me/read-markers (signed) --------------------------------
  router.patch("/read-markers", signed, local, async (c) => {
    const { config, db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const handle = requireLocalHandle(c);
    if (!getUserRow(db, handle)) throw AppError.notFound({ detail: "no such user" });

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = ReadMarkersUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid read-markers update request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    const canonicalActor = `${handle}@${canonicalAuthority(config.domain)}`;

    // Resolve each marker to a provider seq: OFSCP names the newest-read
    // MESSAGE (`lastReadMessageId`); Forumall's own client may send the `seq`
    // directly (extension). A marker naming a message this provider does not
    // hold in that scope is ignored, like an unknown scope — as is any scope the
    // caller can't read, so neither form becomes an existence/activity oracle.
    const entries: { scopeId: string; lastReadSeq: number }[] = [];
    for (const m of parsed.data.markers) {
      if (!canHoldMarker(db, handle, canonicalActor, m.scopeId)) continue;
      const seq =
        m.lastReadMessageId !== undefined
          ? seqForMessage(db, m.scopeId, m.lastReadMessageId)
          : (m.lastReadSeq ?? null);
      if (seq !== null) entries.push({ scopeId: m.scopeId, lastReadSeq: seq });
    }

    // Persist monotonically; `advanced` is the set of scopes actually moved.
    const advanced = setReadMarkers(db, handle, entries);

    // Recompute the touched markers with their new unread counts. Only the
    // scopes that actually advanced are reported (a no-op backward set is
    // dropped).
    const markers = entries
      .filter((m) => advanced.has(m.scopeId))
      .map((m) => unreadEntryFor(db, handle, canonicalActor, m.scopeId, m.lastReadSeq));

    // Multi-device sync (§7.1 style): fan the advance to the actor's OTHER
    // connections. Self-receipt on the originating device is harmless (the
    // store applies it idempotently / monotonically).
    if (markers.length > 0) {
      hub.publishToActor(canonicalActor, {
        type: "read.updated",
        data: { markers },
      });
    }

    return c.json(ReadMarkersResponseSchema.parse({ scopes: markers }), 200);
  });

  return router;
}
