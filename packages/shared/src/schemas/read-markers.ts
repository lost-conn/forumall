/**
 * Read-marker schemas (read/unread tracking — a provider-local extension, not in
 * the OFSCP v0.1 object model). One marker records a user's last-read `seq` in a
 * scope (a channel id `chn_…` or a DM conversation id `dmId`, §7.4); the unread
 * summary stamps a recomputed `unreadCount` onto each scope.
 *
 * All objects are `.passthrough()` per the §2.3 forward-compatibility convention.
 */
import { z } from "zod";

/**
 * A single read-marker entry in the unread summary: the scope, the last-read
 * `seq`, and the number of unread messages in that scope (`seq > lastReadSeq`,
 * excluding the user's own messages).
 */
export const ReadMarkerSchema = z
  .object({
    /** Channel id (`chn_…`) or DM conversation id (`dmId`). */
    scopeId: z.string().min(1),
    /**
     * The newest message the user has read in this scope (OFSCP read markers);
     * absent when nothing has been read yet.
     */
    lastReadMessageId: z.string().min(1).optional(),
    /**
     * Forumall extension (not OFSCP): the provider-internal `seq` of that
     * message, used by Forumall's own web client. Other clients use
     * `lastReadMessageId`. Optional on the wire (other providers omit it).
     */
    lastReadSeq: z.number().int().nonnegative().optional(),
    /** Unread message count in this scope (newer than the marker, own excluded). */
    unreadCount: z.number().int().nonnegative(),
    /** Owning group id for a channel scope; absent for DM scopes. */
    groupId: z.string().optional(),
  })
  .passthrough();
export type ReadMarker = z.infer<typeof ReadMarkerSchema>;

/**
 * GET /api/me/read-markers response: the user's full unread summary — one entry
 * per scope the user can currently see (channels they're a member of + DM
 * conversations in their inbox).
 */
export const ReadMarkersResponseSchema = z
  .object({
    scopes: z.array(ReadMarkerSchema),
  })
  .passthrough();
export type ReadMarkersResponse = z.infer<typeof ReadMarkersResponseSchema>;

/** One marker to set in the PATCH body: advance `scopeId` to `lastReadSeq`. */
export const ReadMarkerUpdateSchema = z
  .object({
    scopeId: z.string().min(1),
    /** OFSCP: the newest message read. Preferred when present. */
    lastReadMessageId: z.string().min(1).optional(),
    /** Forumall extension: the same position as a provider `seq`. */
    lastReadSeq: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .refine((m) => m.lastReadMessageId !== undefined || m.lastReadSeq !== undefined, {
    message: "a marker needs lastReadMessageId (or the Forumall lastReadSeq extension)",
  });
export type ReadMarkerUpdate = z.infer<typeof ReadMarkerUpdateSchema>;

/**
 * PATCH /api/me/read-markers body: one or many markers to advance. Markers are
 * monotonic server-side — a value below the stored marker is ignored.
 */
export const ReadMarkersUpdateRequestSchema = z
  .object({
    markers: z.array(ReadMarkerUpdateSchema).min(1),
  })
  .passthrough();
export type ReadMarkersUpdateRequest = z.infer<typeof ReadMarkersUpdateRequestSchema>;

/**
 * The `read.updated` WS event `data` (multi-device sync): the markers that were
 * just advanced, each with its recomputed `unreadCount`. Fanned to the actor's
 * OTHER devices via `hub.publishToActor`. Same shape as one summary entry.
 */
export const ReadUpdatedEventSchema = z
  .object({
    markers: z.array(ReadMarkerSchema),
  })
  .passthrough();
export type ReadUpdatedEvent = z.infer<typeof ReadUpdatedEventSchema>;
