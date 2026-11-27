/**
 * Read-marker schemas (OFSCP §7.7, OPTIONAL). A marker records, per scope (a
 * channel local id or a DM `dmId`, §7.4), the newest MESSAGE the user has read —
 * named by its id, never by a cursor or a provider-internal position (§2.5). The
 * summary stamps a provider-computed `unreadCount` onto each scope.
 *
 * Mirrors `schemas/v0.1/read-markers-response.json` and
 * `read-markers-update-request.json` (and `ws/read-updated.json`). All objects
 * are `.passthrough()` per the §2.3 forward-compatibility convention: a provider
 * MAY add fields, so a client never rejects them — but nothing here depends on
 * one.
 */
import { z } from "zod";

import { LocalIdSchema } from "./common.ts";

/**
 * One scope in the read-marker summary (`$defs/ReadMarker`): the scope, the
 * newest message read (absent if nothing has been read), and the number of
 * messages newer than the marker not authored by the user (tombstones included).
 */
export const ReadMarkerSchema = z
  .object({
    /** A channel local id or a dmId (§7.7). */
    scopeId: z.string().min(1),
    /** The newest message the user has read in this scope; absent if none. */
    lastReadMessageId: LocalIdSchema.optional(),
    /** Exact count of messages newer than the marker, not authored by the user. */
    unreadCount: z.number().int().nonnegative(),
    /** The channel's group, present for channel scopes. */
    groupId: LocalIdSchema.optional(),
  })
  .passthrough();
export type ReadMarker = z.infer<typeof ReadMarkerSchema>;

/**
 * `GET`/`PATCH /api/me/read-markers` response. For `GET`, one entry per scope the
 * user can currently read; for `PATCH`, only the scopes that actually advanced.
 */
export const ReadMarkersResponseSchema = z
  .object({
    scopes: z.array(ReadMarkerSchema),
  })
  .passthrough();
export type ReadMarkersResponse = z.infer<typeof ReadMarkersResponseSchema>;

/** One marker in the `PATCH` body: advance `scopeId` to `lastReadMessageId`. */
export const ReadMarkerUpdateSchema = z
  .object({
    scopeId: z.string().min(1),
    lastReadMessageId: LocalIdSchema,
  })
  .passthrough();
export type ReadMarkerUpdate = z.infer<typeof ReadMarkerUpdateSchema>;

/**
 * `PATCH /api/me/read-markers` body: at least one marker. Markers only move
 * forward; a backward one, one naming a message the provider does not hold in
 * the scope, and one for an unknown or unreadable scope are ignored (§7.7).
 */
export const ReadMarkersUpdateRequestSchema = z
  .object({
    markers: z.array(ReadMarkerUpdateSchema).min(1),
  })
  .passthrough();
export type ReadMarkersUpdateRequest = z.infer<typeof ReadMarkersUpdateRequestSchema>;

/**
 * The `read.updated` WS event `data`: the same entries as the `PATCH` response
 * that advanced them, sent to all of the user's connections (§7.7).
 */
export const ReadUpdatedEventSchema = z
  .object({
    markers: z.array(ReadMarkerSchema),
  })
  .passthrough();
export type ReadUpdatedEvent = z.infer<typeof ReadUpdatedEventSchema>;
