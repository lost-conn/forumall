/**
 * Notifications / mentions-feed schemas (a provider-LOCAL inbound feed — NOT in
 * the OFSCP v0.1 object model, and distinct from the §10 outbound notification
 * *webhooks*). A notification records that a local user was @mentioned in, or
 * had one of their messages replied to within, a group CHANNEL.
 *
 * State is two independent nullable timestamps:
 *  - `seenAt`  — the notification has APPEARED in the user's inbox list (badge).
 *  - `readAt`  — the user ACTED on it (clicked through). Read implies seen.
 *
 * All objects are `.passthrough()` per the §2.3 forward-compatibility convention.
 */
import { z } from "zod";

import { Rfc3339DateTimeSchema } from "./common.ts";

/** Notification kind: an @mention or a reply to one of the user's messages. */
export const NotificationTypeSchema = z.enum(["mention", "reply"]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

/**
 * One inbound notification row for a recipient. `seenAt` / `readAt` are RFC 3339
 * timestamps when set, otherwise absent (= not seen / not read).
 */
export const NotificationSchema = z
  .object({
    /** Provider-minted id (`ntf_…`). */
    id: z.string().min(1),
    /** `mention` | `reply`. */
    type: NotificationTypeSchema,
    /** The message that triggered this notification (`msg_…`). */
    sourceMessageId: z.string().min(1),
    /** Channel the source message is in (`chn_…`). */
    channelId: z.string().min(1),
    /** Group the channel belongs to (`grp_…`). */
    groupId: z.string().min(1),
    /** Author of the source message (`handle@domain`) — who mentioned/replied. */
    author: z.string().min(1),
    /** Creation time (RFC 3339). */
    createdAt: Rfc3339DateTimeSchema,
    /** When this appeared in the user's inbox list; absent until seen. */
    seenAt: Rfc3339DateTimeSchema.optional(),
    /** When the user acted on it (clicked through); absent until read. */
    readAt: Rfc3339DateTimeSchema.optional(),
  })
  .passthrough();
export type Notification = z.infer<typeof NotificationSchema>;

/** Unread/unseen counts per type, for the inbox-tab badges. */
export const NotificationCountsSchema = z
  .object({
    /** Unseen mention notifications. */
    mention: z.number().int().nonnegative(),
    /** Unseen reply notifications. */
    reply: z.number().int().nonnegative(),
  })
  .passthrough();
export type NotificationCounts = z.infer<typeof NotificationCountsSchema>;

/**
 * GET /api/me/notifications response: a newest-first page of the caller's
 * notifications plus the per-type unseen counts (badges). `nextCursor` is the
 * opaque cursor for the following page, absent at the end.
 */
export const NotificationsResponseSchema = z
  .object({
    items: z.array(NotificationSchema),
    counts: NotificationCountsSchema,
    nextCursor: z.string().min(1).optional(),
  })
  .passthrough();
export type NotificationsResponse = z.infer<typeof NotificationsResponseSchema>;

/**
 * POST /api/me/notifications/{seen,read} body: the specific ids to mark, or an
 * omitted/empty `ids` to mark ALL of the caller's notifications.
 */
export const NotificationsMarkRequestSchema = z
  .object({
    /** Ids to mark; omit or pass `[]` to mark all. */
    ids: z.array(z.string().min(1)).optional(),
  })
  .passthrough();
export type NotificationsMarkRequest = z.infer<typeof NotificationsMarkRequestSchema>;

/**
 * POST /api/me/notifications/{seen,read} response: the recomputed per-type
 * counts after the mark (so a client can refresh badges without a re-list).
 */
export const NotificationsMarkResponseSchema = z
  .object({
    /** Number of rows actually touched by this call. */
    affected: z.number().int().nonnegative(),
    counts: NotificationCountsSchema,
  })
  .passthrough();
export type NotificationsMarkResponse = z.infer<typeof NotificationsMarkResponseSchema>;

/**
 * The `notification.created` WS event `data` (live inbox): the new notification,
 * fanned to the recipient actor's connections via `hub.publishToActor`.
 */
export const NotificationCreatedEventSchema = z
  .object({
    notification: NotificationSchema,
  })
  .passthrough();
export type NotificationCreatedEvent = z.infer<typeof NotificationCreatedEventSchema>;
