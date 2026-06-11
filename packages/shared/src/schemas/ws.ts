/**
 * OFSCP v0.1 WebSocket schemas — the envelope (`ws/envelope.json`,
 * `ws/types.json`) and every command/event payload under `ws/*.json`.
 *
 * Forward-compatibility (§2.3): the envelope's `type` is an OPEN string, and
 * `data` is arbitrary JSON, so a frame carrying an unknown `type` parses
 * without throwing. {@link WsTypeSchema} is a *non-throwing* helper enum that
 * narrows the set of types known to v0.1 — it is NOT used to gate envelope
 * parsing. Each concrete command/event schema below pins `type` to a literal
 * and validates its own `data` shape; these are for when you already know
 * (e.g. after switching on `type`) which frame you're handling.
 */
import { z } from "zod";

import {
  AttachmentSchema,
  DmIdSchema,
  HttpsUriSchema,
  JsonValueSchema,
  MetadataListSchema,
  OpaqueCursorSchema,
  Rfc3339DateTimeSchema,
  UserRefSchema,
} from "./common.ts";
import { MemberSchema } from "./groups.ts";
import { ContentSchema, MessageReferenceSchema, ReactionSchema } from "./messaging.ts";
import { PresenceSchema } from "./privacy.ts";

// ---------------------------------------------------------------------------
// Type enums (ws/types.json) — narrowing helpers only, never used to gate parse
// ---------------------------------------------------------------------------

/** Client → server command type strings known to v0.1 (`WsCommandType`). */
export const WsCommandTypeSchema = z.enum([
  "authenticate",
  "subscribe",
  "unsubscribe",
  "message.create",
  "message.update",
  "message.delete",
  "reaction.add",
  "reaction.remove",
  "typing.start",
  "typing.stop",
  "presence.subscribe",
  "presence.unsubscribe",
  "presence.set",
  "ping",
  "pong",
]);
export type WsCommandType = z.infer<typeof WsCommandTypeSchema>;

/** Server → client event type strings known to v0.1 (`WsEventType`). */
export const WsEventTypeSchema = z.enum([
  "auth.challenge",
  "authenticated",
  "subscribed",
  "unsubscribed",
  "message.created",
  "message.updated",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "channel.typing",
  "member.updated",
  "dm.message",
  "dm.reaction",
  "dm.typing",
  "presence.subscribed",
  "presence.unsubscribed",
  "presence.update",
  "call.started",
  "call.ended",
  "call.participant",
  "ping",
  "pong",
  "error",
]);
export type WsEventType = z.infer<typeof WsEventTypeSchema>;

/** Every WS type known to v0.1 (`WsType`). Open-world: see file header. */
export const WsTypeSchema = z.enum([
  "authenticate",
  "subscribe",
  "unsubscribe",
  "message.create",
  "message.update",
  "message.delete",
  "reaction.add",
  "reaction.remove",
  "typing.start",
  "typing.stop",
  "presence.subscribe",
  "presence.unsubscribe",
  "presence.set",
  "ping",
  "pong",
  "auth.challenge",
  "authenticated",
  "subscribed",
  "unsubscribed",
  "message.created",
  "message.updated",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "channel.typing",
  "member.updated",
  "dm.message",
  "dm.reaction",
  "dm.typing",
  "presence.subscribed",
  "presence.unsubscribed",
  "presence.update",
  "call.started",
  "call.ended",
  "call.participant",
  "error",
]);
export type WsType = z.infer<typeof WsTypeSchema>;

const KNOWN_WS_TYPES: ReadonlySet<string> = new Set(WsTypeSchema.options);

/** True iff `type` is a WS type defined by OFSCP v0.1. Never throws. */
export function isKnownWsType(type: string): type is WsType {
  return KNOWN_WS_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Envelope (ws/envelope.json) — OPEN `type`, arbitrary `data`
// ---------------------------------------------------------------------------

/**
 * The base WS frame (`envelope`). `type` is any non-empty string and `data` is
 * arbitrary JSON, so a frame with a novel/unknown `type` parses successfully
 * (§2.3 forward-compat).
 */
export const WsEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    ts: Rfc3339DateTimeSchema,
    correlationId: z.string().min(1).optional(),
    data: JsonValueSchema.optional(),
  })
  .passthrough();
export type WsEnvelope = z.infer<typeof WsEnvelopeSchema>;

/**
 * Build a concrete frame schema: the envelope fields, a literal `type`, and a
 * specific `data` shape. Stays `.passthrough()` so unknown top-level keys (and,
 * because the `data` schemas are themselves passthrough, unknown data keys) are
 * preserved.
 */
function wsFrame<T extends z.ZodTypeAny>(type: string, data: T) {
  return z
    .object({
      id: z.string().min(1),
      type: z.literal(type),
      ts: Rfc3339DateTimeSchema,
      correlationId: z.string().min(1).optional(),
      data,
    })
    .passthrough();
}

/** A frame whose `data` may be absent or an empty object (ping/pong). */
const emptyData = JsonValueSchema.optional();

// ---------------------------------------------------------------------------
// Commands (client → server)
// ---------------------------------------------------------------------------

/** `authenticate` command. */
export const WsAuthenticateSchema = wsFrame(
  "authenticate",
  z
    .object({
      actor: UserRefSchema,
      keyId: z.string().min(1),
      timestamp: Rfc3339DateTimeSchema,
      signature: z.string().min(1),
    })
    .passthrough(),
);
export type WsAuthenticate = z.infer<typeof WsAuthenticateSchema>;

/** `subscribe` command. */
export const WsSubscribeSchema = wsFrame(
  "subscribe",
  z
    .object({
      channels: z.array(z.string().min(1)).min(1),
      include: z.array(WsEventTypeSchema).optional(),
      since: z.record(OpaqueCursorSchema).optional(),
    })
    .passthrough(),
);
export type WsSubscribe = z.infer<typeof WsSubscribeSchema>;

/** `unsubscribe` command. */
export const WsUnsubscribeSchema = wsFrame(
  "unsubscribe",
  z.object({ channels: z.array(z.string().min(1)).min(1) }).passthrough(),
);
export type WsUnsubscribe = z.infer<typeof WsUnsubscribeSchema>;

/** `message.create` command. */
export const WsMessageCreateSchema = wsFrame(
  "message.create",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      clientMessageId: z.string().min(1).optional(),
      content: ContentSchema,
    })
    .passthrough(),
);
export type WsMessageCreate = z.infer<typeof WsMessageCreateSchema>;

/** `message.update` command. */
export const WsMessageUpdateSchema = wsFrame(
  "message.update",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      content: ContentSchema,
    })
    .passthrough(),
);
export type WsMessageUpdate = z.infer<typeof WsMessageUpdateSchema>;

/** `message.delete` command. */
export const WsMessageDeleteSchema = wsFrame(
  "message.delete",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
    })
    .passthrough(),
);
export type WsMessageDelete = z.infer<typeof WsMessageDeleteSchema>;

/** `reaction.add` command. */
export const WsReactionAddSchema = wsFrame(
  "reaction.add",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      key: z.string().min(1),
      unicode: z.string().optional(),
      image: HttpsUriSchema.optional(),
    })
    .passthrough(),
);
export type WsReactionAdd = z.infer<typeof WsReactionAddSchema>;

/** `reaction.remove` command. */
export const WsReactionRemoveSchema = wsFrame(
  "reaction.remove",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      key: z.string().min(1),
    })
    .passthrough(),
);
export type WsReactionRemove = z.infer<typeof WsReactionRemoveSchema>;

/**
 * `typing.start` command. Targets either a channel (`channelId`) OR a DM
 * conversation (`dmId`) — exactly one. Both fields are optional on the schema
 * (open-world) and the server requires one of them; a DM-scoped typing frame
 * fans out a `dm.typing` event to the counterparty (§7.4).
 */
export const WsTypingStartSchema = wsFrame(
  "typing.start",
  z.object({ channelId: z.string().min(1).optional(), dmId: DmIdSchema.optional() }).passthrough(),
);
export type WsTypingStart = z.infer<typeof WsTypingStartSchema>;

/** `typing.stop` command. Targets either a channel (`channelId`) or a DM (`dmId`). */
export const WsTypingStopSchema = wsFrame(
  "typing.stop",
  z.object({ channelId: z.string().min(1).optional(), dmId: DmIdSchema.optional() }).passthrough(),
);
export type WsTypingStop = z.infer<typeof WsTypingStopSchema>;

/** `presence.subscribe` command. */
export const WsPresenceSubscribeSchema = wsFrame(
  "presence.subscribe",
  z.object({ users: z.array(UserRefSchema).min(1) }).passthrough(),
);
export type WsPresenceSubscribe = z.infer<typeof WsPresenceSubscribeSchema>;

/** `presence.unsubscribe` command. */
export const WsPresenceUnsubscribeSchema = wsFrame(
  "presence.unsubscribe",
  z.object({ users: z.array(UserRefSchema).min(1) }).passthrough(),
);
export type WsPresenceUnsubscribe = z.infer<typeof WsPresenceUnsubscribeSchema>;

/** `presence.set` command. `offline` is connection-derived, not settable here. */
export const WsPresenceSetSchema = wsFrame(
  "presence.set",
  z
    .object({
      availability: z.enum(["online", "away", "dnd"]),
      status: z.string().optional(),
      metadata: MetadataListSchema.optional(),
    })
    .passthrough(),
);
export type WsPresenceSet = z.infer<typeof WsPresenceSetSchema>;

// ---------------------------------------------------------------------------
// Events (server → client)
// ---------------------------------------------------------------------------

/** `auth.challenge` event. */
export const WsAuthChallengeSchema = wsFrame(
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
export const WsAuthenticatedSchema = wsFrame(
  "authenticated",
  z.object({ actor: UserRefSchema }).passthrough(),
);
export type WsAuthenticated = z.infer<typeof WsAuthenticatedSchema>;

/** `subscribed` event. */
export const WsSubscribedSchema = wsFrame(
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

/** `unsubscribed` event. */
export const WsUnsubscribedSchema = wsFrame(
  "unsubscribed",
  z.object({ channels: z.array(z.string().min(1)) }).passthrough(),
);
export type WsUnsubscribed = z.infer<typeof WsUnsubscribedSchema>;

/** Compact message shape embedded in message.created / message.updated. */
const WsMessagePayloadSchema = z
  .object({
    id: z.string().min(1),
    clientMessageId: z.string().min(1).optional(),
    author: UserRefSchema,
    createdAt: Rfc3339DateTimeSchema,
    editedAt: Rfc3339DateTimeSchema.optional(),
    content: ContentSchema,
  })
  .passthrough();
export type WsMessagePayload = z.infer<typeof WsMessagePayloadSchema>;

/** `message.created` event. */
export const WsMessageCreatedSchema = wsFrame(
  "message.created",
  z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      cursor: OpaqueCursorSchema.optional(),
      message: WsMessagePayloadSchema,
    })
    .passthrough(),
);
export type WsMessageCreated = z.infer<typeof WsMessageCreatedSchema>;

/** `message.updated` event. */
export const WsMessageUpdatedSchema = wsFrame(
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
      message: WsMessagePayloadSchema,
    })
    .passthrough(),
);
export type WsMessageUpdated = z.infer<typeof WsMessageUpdatedSchema>;

/** `message.deleted` event. */
export const WsMessageDeletedSchema = wsFrame(
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
export const WsReactionAddedSchema = wsFrame(
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
export const WsReactionRemovedSchema = wsFrame(
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
export const WsChannelTypingSchema = wsFrame(
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
export const WsMemberUpdatedSchema = wsFrame(
  "member.updated",
  z
    .object({
      groupId: z.string().min(1),
      member: MemberSchema,
    })
    .passthrough(),
);
export type WsMemberUpdated = z.infer<typeof WsMemberUpdatedSchema>;

/** `dm.message` event. */
export const WsDmMessageSchema = wsFrame(
  "dm.message",
  z
    .object({
      dmId: DmIdSchema,
      cursor: OpaqueCursorSchema.optional(),
      message: z
        .object({
          id: z.string().min(1),
          clientMessageId: z.string().min(1).optional(),
          author: UserRefSchema,
          createdAt: Rfc3339DateTimeSchema,
          content: ContentSchema,
          // Attachments + reply reference flow through the live event (parity
          // with channel `message.created`), so a DM with media / a reply
          // renders without a re-fetch. Both optional + passthrough.
          attachments: z.array(AttachmentSchema).optional(),
          reference: MessageReferenceSchema.optional(),
          editedAt: Rfc3339DateTimeSchema.optional(),
          deletedAt: Rfc3339DateTimeSchema.optional(),
        })
        .passthrough(),
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
export const WsDmReactionSchema = wsFrame(
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
export const WsDmTypingSchema = wsFrame(
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

/** `presence.subscribed` event. */
export const WsPresenceSubscribedSchema = wsFrame(
  "presence.subscribed",
  z.object({ users: z.array(UserRefSchema) }).passthrough(),
);
export type WsPresenceSubscribed = z.infer<typeof WsPresenceSubscribedSchema>;

/** `presence.unsubscribed` event. */
export const WsPresenceUnsubscribedSchema = wsFrame(
  "presence.unsubscribed",
  z.object({ users: z.array(UserRefSchema) }).passthrough(),
);
export type WsPresenceUnsubscribed = z.infer<typeof WsPresenceUnsubscribedSchema>;

/** `presence.update` event. */
export const WsPresenceUpdateSchema = wsFrame(
  "presence.update",
  z
    .object({
      user: UserRefSchema,
      presence: PresenceSchema,
    })
    .passthrough(),
);
export type WsPresenceUpdate = z.infer<typeof WsPresenceUpdateSchema>;

/** `call.started` event. */
export const WsCallStartedSchema = wsFrame(
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
export const WsCallEndedSchema = wsFrame(
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
export const WsCallParticipantSchema = wsFrame(
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

// ---------------------------------------------------------------------------
// Heartbeat + error
// ---------------------------------------------------------------------------

/** `ping` frame. `data` is optional (samples send `{}`). */
export const WsPingSchema = wsFrame("ping", emptyData);
export type WsPing = z.infer<typeof WsPingSchema>;

/** `pong` frame. `data` is optional (samples send `{}`). */
export const WsPongSchema = wsFrame("pong", emptyData);
export type WsPong = z.infer<typeof WsPongSchema>;

/** `error` event. */
export const WsErrorSchema = wsFrame(
  "error",
  z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      status: z.number().int().min(100).max(599),
      details: JsonValueSchema.optional(),
    })
    .passthrough(),
);
export type WsError = z.infer<typeof WsErrorSchema>;
