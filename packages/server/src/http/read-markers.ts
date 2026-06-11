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
 * Read state is private + per-account; a scope the user can't see is harmless
 * (markers are private state) so an unknown/unseen scope is accepted, never 404'd
 * — the PATCH is idempotent.
 */
import {
  ReadMarkersResponseSchema,
  ReadMarkersUpdateRequestSchema,
  canonicalAuthority,
} from "@forumall/shared";
import { Hono } from "hono";

import { getUserRow } from "../provider/guests.ts";
import { getUnreadSummary, setReadMarkers, unreadEntryFor } from "../provider/read-markers.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/**
 * The caller-facing read-marker router. Mounted at `/api/me`, so it serves
 * `/api/me/read-markers`.
 */
export function createMeReadMarkersRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- GET /api/me/read-markers (signed) ----------------------------------
  router.get("/read-markers", signed, (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const scopes = getUnreadSummary(
      db,
      actor.handle,
      `${actor.handle}@${canonicalAuthority(config.domain)}`,
    );
    return c.json(ReadMarkersResponseSchema.parse({ scopes }), 200);
  });

  // -- PATCH /api/me/read-markers (signed) --------------------------------
  router.patch("/read-markers", signed, async (c) => {
    const { config, db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    if (!getUserRow(db, actor.handle)) throw AppError.notFound({ detail: "no such user" });

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

    const canonicalActor = `${actor.handle}@${canonicalAuthority(config.domain)}`;

    // Persist monotonically; `advanced` is the set of scopes actually moved.
    const advanced = setReadMarkers(
      db,
      actor.handle,
      parsed.data.markers.map((m) => ({ scopeId: m.scopeId, lastReadSeq: m.lastReadSeq })),
    );

    // Recompute the touched markers with their new unread counts. Only the
    // scopes that actually advanced are reported (a no-op backward set is
    // dropped). For each advanced scope we read back the persisted lastReadSeq.
    const markers = parsed.data.markers
      .filter((m) => advanced.has(m.scopeId))
      .map((m) => unreadEntryFor(db, actor.handle, canonicalActor, m.scopeId, m.lastReadSeq));

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
