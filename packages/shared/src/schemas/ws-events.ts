/**
 * OFSCP v0.1 WebSocket events (server → client, `ws/*.json`). Each schema pins
 * `type` to a literal and validates its own `data` shape on the event envelope
 * (`ws/event-envelope.json`): `ts` is a required RFC 3339 timestamp (§7.1).
 */
import { z } from "zod";

import {
  DmIdSchema,
  HttpsUriSchema,
  OpaqueCursorSchema,
  Rfc3339DateTimeSchema,
  UserRefSchema,
} from "./common.ts";
import { GroupPointerSchema, MemberSchema } from "./groups.ts";
import { DmConversationSchema, MessageSchema, ReactionSchema } from "./messaging.ts";
import { NotificationSchema } from "./notifications.ts";
import { PresenceSchema } from "./privacy.ts";
import { ReadUpdatedEventSchema } from "./read-markers.ts";
import { wsEvent } from "./ws-frame.ts";

// ---------------------------------------------------------------------------
// Events (server → client)
// ---------------------------------------------------------------------------

/** `auth.challenge` event. */
export const WsAuthChallengeSchema = wsEvent(
  "auth.challenge",
  z
    .object({
      nonce: z.string().min(1),
      expiresAt: Rfc3339DateTimeSchema,
    })
    .passthrough(),
);
export type WsAuthChallenge = z.infer<typeof WsAuthChallengeSchema>;

/** `authenticated` event. */
export const WsAuthenticatedSchema = wsEvent(
  "authenticated",
  z.object({ actor: UserRefSchema }).passthrough(),
);
export type WsAuthenticated = z.infer<typeof WsAuthenticatedSchema>;

/** `subscribed` event. */
export const WsSubscribedSchema = wsEvent(
  "subscribed",
  z
    .object({
      channels: z.array(z.string().min(1)),
      // Channels whose resume (`since`) gap exceeded what the provider will
      // replay (§7.1 "Resuming after a disconnect"): the client MUST fall back to
      // REST history (§7.2) to backfill. Present only when non-empty.
      truncated: z.array(z.string().min(1)).optional(),
    })
    .passthrough(),
);
export type WsSubscribed = z.infer<typeof WsSubscribedSchema>;

/**
 * `unsubscribed` event. `reason` is present only on an unprompted unsubscribe
 * (§7.1 "Losing access"), e.g. `access_revoked`.
 */
export const WsUnsubscribedSchema = wsEvent(
  "unsubscribed",
  z
    .object({
      channels: z.array(z.string().min(1)),
      reason: z.string().min(1).optional(),
    })
    .passthrough(),
);
export type WsUnsubscribed = z.infer<typeof WsUnsubscribedSchema>;

/** `message.created` event. */
export const WsMessageCreatedSchema = wsEvent(
  "message.created",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      cursor: OpaqueCursorSchema.optional(),
      message: MessageSchema,
    })
    .passthrough(),
);
export type WsMessageCreated = z.infer<typeof WsMessageCreatedSchema>;

/** `message.updated` event. */
export const WsMessageUpdatedSchema = wsEvent(
  "message.updated",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      // Opaque timeline cursor for this message (§7.1 resume / §7.2 history share
      // one cursor space). Optional to stay forward/backward compatible; mirrors
      // `message.created`. Carrying it lets a client advance its resume position
      // off updated/deleted events too.
      cursor: OpaqueCursorSchema.optional(),
      message: MessageSchema,
    })
    .passthrough(),
);
export type WsMessageUpdated = z.infer<typeof WsMessageUpdatedSchema>;

/** `message.deleted` event. */
export const WsMessageDeletedSchema = wsEvent(
  "message.deleted",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      // Opaque timeline cursor for the tombstoned message (same cursor space as
      // `message.created`/history). Optional; see `message.updated` above.
      cursor: OpaqueCursorSchema.optional(),
      deletedAt: Rfc3339DateTimeSchema.optional(),
    })
    .passthrough(),
);
export type WsMessageDeleted = z.infer<typeof WsMessageDeletedSchema>;

/** `reaction.added` event. */
export const WsReactionAddedSchema = wsEvent(
  "reaction.added",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      reaction: ReactionSchema,
    })
    .passthrough(),
);
export type WsReactionAdded = z.infer<typeof WsReactionAddedSchema>;

/** `reaction.removed` event. */
export const WsReactionRemovedSchema = wsEvent(
  "reaction.removed",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      key: z.string().min(1),
      author: UserRefSchema,
    })
    .passthrough(),
);
export type WsReactionRemoved = z.infer<typeof WsReactionRemovedSchema>;

/** `channel.typing` event. */
export const WsChannelTypingSchema = wsEvent(
  "channel.typing",
  z
    .object({
      channelId: z.string().min(1),
      user: UserRefSchema,
      state: z.enum(["start", "stop"]),
    })
    .passthrough(),
);
export type WsChannelTyping = z.infer<typeof WsChannelTypingSchema>;

/**
 * `member.updated` event — a member's group-scoped state changed (e.g. their
 * per-group `displayNameOverride` or `role`). Carries the full canonical
 * `Member` for the group so clients can reconcile their member cache / chat
 * author names live. Passthrough, like every other event.
 */
export const WsMemberUpdatedSchema = wsEvent(
  "member.updated",
  z
    .object({
      groupId: z.string().min(1),
      member: MemberSchema,
    })
    .passthrough(),
);
export type WsMemberUpdated = z.infer<typeof WsMemberUpdatedSchema>;

/**
 * `groups.updated` event — the user's group list changed (§5.7 My groups);
 * sent to all of the user's connections. `groups` holds added or changed
 * entries, `removed` the group URIs that left the list; at least one of the
 * two is non-empty.
 */
export const WsGroupsUpdatedSchema = wsEvent(
  "groups.updated",
  z
    .object({
      groups: z.array(GroupPointerSchema),
      removed: z.array(HttpsUriSchema),
    })
    .passthrough()
    .refine((d) => d.groups.length > 0 || d.removed.length > 0, {
      message: "groups.updated must carry at least one added, changed or removed group",
    }),
);
export type WsGroupsUpdated = z.infer<typeof WsGroupsUpdatedSchema>;

/** `dm.message` event. */
export const WsDmMessageSchema = wsEvent(
  "dm.message",
  z
    .object({
      dmId: DmIdSchema,
      cursor: OpaqueCursorSchema.optional(),
      // The full canonical message (§5.3, §7.4) — the same object
      // GET /api/dms/{dmId}/messages returns; after an edit or delete, the
      // updated message (editedAt / deletedAt set).
      message: MessageSchema,
    })
    .passthrough(),
);
export type WsDmMessage = z.infer<typeof WsDmMessageSchema>;

/**
 * `dm.reaction` event — a reaction was added to / removed from a DM message
 * (mirrors the channel `reaction.added`/`reaction.removed` events, DM-scoped by
 * `dmId`). `state: "added"` carries the full canonical `reaction`; `state:
 * "removed"` carries the `messageId`/`key`/`author` of the removed reaction.
 * Fanned out to BOTH DM participants. Passthrough, like every other event.
 */
export const WsDmReactionSchema = wsEvent(
  "dm.reaction",
  z
    .object({
      dmId: DmIdSchema,
      messageId: z.string().min(1),
      state: z.enum(["added", "removed"]),
      // For `added`, the full `reaction` carries author/key/unicode; for
      // `removed`, the top-level `author`/`key` identify what was removed. Both
      // top-level fields are optional so the `added` form (author/key inside
      // `reaction`) validates; this provider always also stamps them.
      author: UserRefSchema.optional(),
      key: z.string().min(1).optional(),
      reaction: ReactionSchema.optional(),
    })
    .passthrough(),
);
export type WsDmReaction = z.infer<typeof WsDmReactionSchema>;

/**
 * `dm.typing` event — a participant started/stopped typing in a DM (mirrors
 * `channel.typing`, DM-scoped by `dmId`). Fanned out to the OTHER participant.
 */
export const WsDmTypingSchema = wsEvent(
  "dm.typing",
  z
    .object({
      dmId: DmIdSchema,
      user: UserRefSchema,
      state: z.enum(["start", "stop"]),
    })
    .passthrough(),
);
export type WsDmTyping = z.infer<typeof WsDmTypingSchema>;

/**
 * `dm.conversation` event (OFSCP §7.4): a conversation in the user's list was
 * created or updated by one of their own sends — fanned to all of the user's
 * connections so their other devices see conversations they started.
 */
export const WsDmConversationSchema = wsEvent(
  "dm.conversation",
  z.object({ conversation: DmConversationSchema }).passthrough(),
);
export type WsDmConversation = z.infer<typeof WsDmConversationSchema>;

/** `presence.subscribed` event. */
export const WsPresenceSubscribedSchema = wsEvent(
  "presence.subscribed",
  z.object({ users: z.array(UserRefSchema) }).passthrough(),
);
export type WsPresenceSubscribed = z.infer<typeof WsPresenceSubscribedSchema>;

/** `presence.unsubscribed` event. */
export const WsPresenceUnsubscribedSchema = wsEvent(
  "presence.unsubscribed",
  z.object({ users: z.array(UserRefSchema) }).passthrough(),
);
export type WsPresenceUnsubscribed = z.infer<typeof WsPresenceUnsubscribedSchema>;

/** `presence.update` event. */
export const WsPresenceUpdateSchema = wsEvent(
  "presence.update",
  z
    .object({
      user: UserRefSchema,
      presence: PresenceSchema,
    })
    .passthrough(),
);
export type WsPresenceUpdate = z.infer<typeof WsPresenceUpdateSchema>;

/**
 * `read.updated` event (§7.7) — the caller's read markers advanced. Sent by
 * `hub.publishToActor` to all of the actor's connections after a
 * `PATCH /api/me/read-markers`, carrying the same entries as that response.
 * Passthrough, like every other event.
 */
export const WsReadUpdatedSchema = wsEvent("read.updated", ReadUpdatedEventSchema);
export type WsReadUpdated = z.infer<typeof WsReadUpdatedSchema>;

/**
 * `notification.created` event — a new inbound notification (an @mention or a
 * reply to one of the caller's messages, a provider-local feed). Fanned by
 * `hub.publishToActor` to all of the recipient actor's connections for a live
 * inbox. Passthrough, like every other event.
 */
export const WsNotificationCreatedSchema = wsEvent(
  "notification.created",
  z
    .object({
      notification: NotificationSchema,
    })
    .passthrough(),
);
export type WsNotificationCreated = z.infer<typeof WsNotificationCreatedSchema>;

/** `call.started` event. */
export const WsCallStartedSchema = wsEvent(
  "call.started",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      startedBy: UserRefSchema,
      startedAt: Rfc3339DateTimeSchema,
    })
    .passthrough(),
);
export type WsCallStarted = z.infer<typeof WsCallStartedSchema>;

/** `call.ended` event. */
export const WsCallEndedSchema = wsEvent(
  "call.ended",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      endedAt: Rfc3339DateTimeSchema,
    })
    .passthrough(),
);
export type WsCallEnded = z.infer<typeof WsCallEndedSchema>;

/** `call.participant` event. */
export const WsCallParticipantSchema = wsEvent(
  "call.participant",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      user: UserRefSchema,
      state: z.enum(["joined", "left"]),
    })
    .passthrough(),
);
export type WsCallParticipant = z.infer<typeof WsCallParticipantSchema>;
