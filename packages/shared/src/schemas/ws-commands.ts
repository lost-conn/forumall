/**
 * OFSCP v0.1 WebSocket commands (client → server, `ws/*.json`). Each schema
 * pins `type` to a literal and validates its own `data` shape on the command
 * envelope (`ws/command-envelope.json`): `id` required, `ts` optional with its
 * value ignored (§7.1).
 */
import { z } from "zod";

import {
  DmIdSchema,
  HttpsUriSchema,
  OpaqueCursorSchema,
  Rfc3339DateTimeSchema,
  UserRefSchema,
} from "./common.ts";
import {
  MessageCreateRequestSchema,
  MessageUpdateFieldsSchema,
  NO_EDIT_FIELD_MESSAGE,
  carriesAnEditField,
} from "./messaging.ts";
import { PresenceUpdateRequestSchema } from "./privacy.ts";
import { WsEventTypeSchema } from "./ws-envelope.ts";
import { wsCommand } from "./ws-frame.ts";

// ---------------------------------------------------------------------------
// Commands (client → server)
// ---------------------------------------------------------------------------

/** `authenticate` command. */
export const WsAuthenticateSchema = wsCommand(
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
export const WsSubscribeSchema = wsCommand(
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
export const WsUnsubscribeSchema = wsCommand(
  "unsubscribe",
  z.object({ channels: z.array(z.string().min(1)).min(1) }).passthrough(),
);
export type WsUnsubscribe = z.infer<typeof WsUnsubscribeSchema>;

/**
 * `message.create` command: the `MessageCreate` body (shared with the REST
 * create, §7.1) plus the target `groupId` and `channelId`.
 */
export const WsMessageCreateSchema = wsCommand(
  "message.create",
  MessageCreateRequestSchema.extend({
    groupId: z.string().min(1),
    channelId: z.string().min(1),
  }),
);
export type WsMessageCreate = z.infer<typeof WsMessageCreateSchema>;

/**
 * `message.update` command: the `MessageUpdate` body (shared with the REST
 * PATCH, §7.1) plus the target `groupId`, `channelId` and `messageId`. Like the
 * PATCH, it must carry at least one edit field.
 */
export const WsMessageUpdateSchema = wsCommand(
  "message.update",
  MessageUpdateFieldsSchema.extend({
    groupId: z.string().min(1),
    channelId: z.string().min(1),
    messageId: z.string().min(1),
  }).refine(carriesAnEditField, { message: NO_EDIT_FIELD_MESSAGE }),
);
export type WsMessageUpdate = z.infer<typeof WsMessageUpdateSchema>;

/** `message.delete` command. */
export const WsMessageDeleteSchema = wsCommand(
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
export const WsReactionAddSchema = wsCommand(
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
export const WsReactionRemoveSchema = wsCommand(
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
export const WsTypingStartSchema = wsCommand(
  "typing.start",
  z.object({ channelId: z.string().min(1).optional(), dmId: DmIdSchema.optional() }).passthrough(),
);
export type WsTypingStart = z.infer<typeof WsTypingStartSchema>;

/** `typing.stop` command. Targets either a channel (`channelId`) or a DM (`dmId`). */
export const WsTypingStopSchema = wsCommand(
  "typing.stop",
  z.object({ channelId: z.string().min(1).optional(), dmId: DmIdSchema.optional() }).passthrough(),
);
export type WsTypingStop = z.infer<typeof WsTypingStopSchema>;

/** `presence.subscribe` command. */
export const WsPresenceSubscribeSchema = wsCommand(
  "presence.subscribe",
  z.object({ users: z.array(UserRefSchema).min(1) }).passthrough(),
);
export type WsPresenceSubscribe = z.infer<typeof WsPresenceSubscribeSchema>;

/** `presence.unsubscribe` command. */
export const WsPresenceUnsubscribeSchema = wsCommand(
  "presence.unsubscribe",
  z.object({ users: z.array(UserRefSchema).min(1) }).passthrough(),
);
export type WsPresenceUnsubscribe = z.infer<typeof WsPresenceUnsubscribeSchema>;

/**
 * `presence.set` command: the same full-replace body as `PUT /api/me/presence`
 * (§6.4/§7.5). `offline` is connection-derived, not settable here.
 */
export const WsPresenceSetSchema = wsCommand("presence.set", PresenceUpdateRequestSchema);
export type WsPresenceSet = z.infer<typeof WsPresenceSetSchema>;
