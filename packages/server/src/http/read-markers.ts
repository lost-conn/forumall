/**
 * Read-marker router (OFSCP §7.7, OPTIONAL). Two signed local-account endpoints,
 * mounted at `/api/me`:
 *
 *  - `GET  /api/me/read-markers` — `{ scopes: [{ scopeId, lastReadMessageId?,
 *    unreadCount, groupId? }] }`: one entry per channel the caller can read in a
 *    group it belongs to, and per DM conversation in its list.
 *  - `PATCH /api/me/read-markers` — `{ markers: [{ scopeId, lastReadMessageId }] }`
 *    (at least one; anything else is `400`). Markers only move forward. Returns
 *    `{ scopes }` with only the scopes that advanced, and emits `read.updated`
 *    with the same entries to all of the caller's connections.
 *
 * A marker on a scope the caller can't currently read (or a DM not in its
 * list), or naming a message this provider does not hold in the scope, is
 * ignored exactly like an unknown scope — `200`, never `403`/`404`, so the
 * response can't confirm a scope or message exists. The PATCH is idempotent.
 */
import {
  ReadMarkersResponseSchema,
  ReadMarkersUpdateRequestSchema,
  canonicalAuthority,
} from "@forumall/shared";
import { Hono } from "hono";

import { getUserRow } from "../provider/guests.ts";
import { applyReadMarkerUpdates, getUnreadSummary } from "../provider/read-markers.ts";
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
    // Resolve, authorize and persist (monotonically); only the scopes that
    // actually advanced come back, each once.
    const markers = applyReadMarkerUpdates(db, handle, canonicalActor, parsed.data.markers);

    // §7.7: emit `read.updated` with the same entries to all of the caller's
    // connections (the originating device applies it idempotently).
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
