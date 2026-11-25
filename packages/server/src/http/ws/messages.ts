/**
 * §7.1 message commands — `message.create` (with idempotency, fan-out and the
 * §10 / mention notifications it triggers), `message.update`, `message.delete` —
 * and the `message.created` / `message.updated` event builders that resume
 * replay reuses.
 */
import {
  AttachmentSchema,
  type Message,
  MessageKindSchema,
  MessageReferenceSchema,
  WsMessageCreateSchema,
  WsMessageCreatedSchema,
  WsMessageDeleteSchema,
  WsMessageDeletedSchema,
  WsMessageUpdateSchema,
  WsMessageUpdatedSchema,
  rfc3339Timestamp,
} from "@forumall/shared";
import { z } from "zod";
import { fireMessageNotifications } from "../../provider/message-notifications.ts";
import {
  type MessageRecord,
  createMessage,
  getMessageByClientId,
  tombstoneMessage,
  updateMessageContent,
} from "../../provider/messages.ts";
import { deliverNotification, groupMemberActors } from "../../provider/notifications.ts";
import type { OutboundEvent } from "../../provider/ws-hub.ts";
import {
  authorizeChannelPost,
  authorizeMessageDelete,
  authorizeMessageEdit,
} from "../message-mutations.ts";
import { type ConnState, type WsContext, type WsCtx, errorEvent } from "./connection.ts";

/**
 * §7.1 Sending messages: validate the command, authorize the actor against the
 * channel (must exist + be visible + carry the group `post` permission), apply
 * `(author, channelId, clientMessageId)` idempotency, persist, then fan out
 * `message.created` to every connection subscribed to the channel — INCLUDING
 * the author's own connection (the example's author copy carries the request
 * `correlationId`).
 *
 * The author is ALWAYS the connection's authenticated actor; any `author` in
 * the client payload is ignored. Each timeline event carries the message's
 * opaque `cursor` (§7.1 resume / §7.2 history share one cursor space), placed
 * on the event `data`.
 */
export function handleMessageCreate(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { config, db, hub } = ctx;
  const parsed = WsMessageCreateSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed message.create command", frameId));
    return;
  }
  const hubConn = state.hubConn;
  const author = state.actor;
  if (!hubConn || !author) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, clientMessageId, content } = parsed.data.data;
  // `type` / `attachments` / `reference` are open-world passthrough on the
  // command schema; validate them here against the canonical shapes.
  const extra = parsed.data.data as Record<string, unknown>;
  const attachments = AttachmentsSchema.safeParse(extra.attachments);
  const reference = MessageReferenceSchema.safeParse(extra.reference);
  // Message kind (§5.3): default to a chat `message`; reject an unknown kind.
  const typeResult = MessageKindSchema.safeParse(extra.type ?? "message");
  if (!typeResult.success) {
    hub.send(ws, errorEvent("bad_request", "invalid message type", frameId));
    return;
  }
  const type = typeResult.data;
  const ref = reference.success ? reference.data : undefined;
  // Tags (§5.3, e.g. an article's topic tags / promote lineage marker) are an
  // open-world passthrough on the command; accept a plain string array.
  const tags = Array.isArray(extra.tags)
    ? extra.tags.filter((t): t is string => typeof t === "string")
    : undefined;

  // --- Authorization (§5.2.1) -------------------------------------------
  // The channel must exist in the named group, be readable by the actor, and
  // the actor must be permitted to post a message of this `type` (per-channel
  // overrides falling back to the group `post` action), satisfying any reply
  // qualification. Existence failures surface as forbidden (don't leak).
  const postError = authorizeChannelPost(db, groupId, channelId, author, type, ref);
  if (postError) {
    hub.send(ws, errorEvent(postError.code, postError.message, frameId));
    return;
  }

  // --- Idempotency: short-circuit a known duplicate ----------------------
  if (clientMessageId !== undefined) {
    const existing = getMessageByClientId(db, author, channelId, clientMessageId);
    if (existing) {
      // Duplicate re-send: reply to the REQUESTING connection only with the
      // canonical message.created; do NOT re-fan-out to everyone.
      hub.send(ws, createdEvent(groupId, channelId, existing, frameId));
      return;
    }
  }

  // --- Persist -----------------------------------------------------------
  let record: MessageRecord;
  try {
    record = createMessage(db, config, {
      channelId,
      groupId,
      author,
      type,
      content,
      ...(attachments.success ? { attachments: attachments.data } : {}),
      ...(ref ? { reference: ref } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
    });
  } catch (err) {
    // Idempotency race: a concurrent create won the unique
    // (author, channelId, clientMessageId) index. Fall back to the row it
    // inserted and reply (to us only) with the canonical message.
    if (clientMessageId !== undefined && isUniqueViolation(err)) {
      const winner = getMessageByClientId(db, author, channelId, clientMessageId);
      if (winner) {
        hub.send(ws, createdEvent(groupId, channelId, winner, frameId));
        return;
      }
    }
    throw err;
  }

  // --- Fan out -----------------------------------------------------------
  // Deliver to every subscriber of the channel, including the author's own
  // connection. The author's copy correlates to the request id (§7.1).
  hub.publishToChannel(channelId, createdEvent(groupId, channelId, record, frameId));

  // --- Notification webhooks (§10) ---------------------------------------
  // Fire-and-forget: also deliver a `message.created` notification to every
  // registered endpoint whose owner is a member of the message's group and who
  // subscribed to the event. Scoping rule: member-of-group ∧ subscribed; the
  // author is excluded (they don't need to be notified of their own message).
  // This MUST NOT block the WS fan-out, so we don't await — errors (including
  // zero-endpoint no-ops, which resolve cleanly) are logged off the promise.
  fireMessageCreatedNotifications(ctx, groupId, channelId, record, author);

  // --- Inbound notifications feed (provider-local) -----------------------
  // Derive @mention + thread-reply notifications for LOCAL recipients and fan a
  // `notification.created` to each (live inbox). DEFENSIVE + NON-BLOCKING: the
  // helper swallows its own errors so message creation can never break here.
  // `ref` carries the reply parent (when `type === "reply"`); the body text is
  // the parsed mention source.
  const replyToId = ref?.type === "reply" ? ref.id : undefined;
  const contentText =
    typeof (content as { text?: unknown }).text === "string"
      ? (content as { text: string }).text
      : "";
  fireMessageNotifications(db, config, hub, {
    text: contentText,
    author,
    sourceMessageId: record.message.id,
    channelId,
    groupId,
    ...(replyToId !== undefined ? { replyToId } : {}),
  });
}

/**
 * §10 fan-out hook for `message.created`. Non-blocking: builds the owner filter
 * (group members minus the author) and hands off to {@link deliverNotification}
 * without awaiting, logging any rejection. A group with no subscribed endpoints
 * resolves to an empty result (no outbound requests).
 */
function fireMessageCreatedNotifications(
  ctx: WsCtx,
  groupId: string,
  channelId: string,
  record: MessageRecord,
  author: string,
): void {
  const { config, db, federationFetch } = ctx;
  const ownerFilter = groupMemberActors(db, groupId, author);
  void deliverNotification(db, config, federationFetch, {
    event: "message.created",
    resource: { id: record.message.id, channel: channelId },
    ownerFilter,
  }).catch((err) => {
    console.error("notification delivery (message.created) failed:", err);
  });
}

/**
 * §7.1 Editing messages: replace a message's `content`. Only the **author** may
 * edit, and only while `permissions.editUntil` is in the future; otherwise
 * reject with 403. On success stamp `edited_at` and fan out `message.updated`
 * to every channel subscriber (the author's own copy correlates to the request
 * id). Missing message / wrong channel/group → 404; not author or window passed
 * → 403.
 */
export function handleMessageUpdate(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { db, hub } = ctx;
  const parsed = WsMessageUpdateSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed message.update command", frameId));
    return;
  }
  const actor = state.actor;
  if (!actor) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId, content } = parsed.data.data;
  const outcome = authorizeMessageEdit(db, groupId, channelId, messageId, actor);
  if (outcome.error) {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
    return;
  }

  const record = updateMessageContent(db, channelId, messageId, content);
  hub.publishToChannel(channelId, updatedEvent(groupId, channelId, record, frameId));
}

/**
 * §7.1 Deleting messages: tombstone (soft-delete) a message — keep `id`/`seq`,
 * clear `content`, set `deleted_at`. The **author** OR a member with the
 * `moderate` role may delete. On success fan out `message.deleted`. Missing
 * message / wrong channel/group → 404; not permitted → 403.
 */
export function handleMessageDelete(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { db, hub } = ctx;
  const parsed = WsMessageDeleteSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed message.delete command", frameId));
    return;
  }
  const actor = state.actor;
  if (!actor) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId } = parsed.data.data;
  const outcome = authorizeMessageDelete(db, groupId, channelId, messageId, actor);
  if (outcome.error) {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
    return;
  }

  const record = tombstoneMessage(db, channelId, messageId);
  const deletedAt = record.message.deletedAt ?? rfc3339Timestamp();
  hub.publishToChannel(channelId, {
    type: "message.deleted",
    data: WsMessageDeletedSchema.shape.data.parse({
      groupId,
      channelId,
      messageId,
      cursor: record.cursor,
      deletedAt,
    }),
  });
}
/** Validates the optional `attachments` array on a `message.create` command. */
const AttachmentsSchema = z.array(AttachmentSchema);

/**
 * Build a validated `message.created` event for `record`, with the message's
 * opaque `cursor` on `data` (§7.1 resume / §7.2 history share one cursor space).
 * When `correlationId` is given it is echoed (the author's own copy correlates to
 * the request per the §7.1 example); resume replays pass `undefined` since a
 * replayed event is not a response to any client frame. The fan-out payload is
 * re-validated against the shared `WsMessageCreated` schema before the wire.
 */
export function createdEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId?: string,
): OutboundEvent {
  const message = record.message satisfies Message;
  const data = WsMessageCreatedSchema.shape.data.parse({
    groupId,
    channelId,
    cursor: record.cursor,
    message,
  });
  return {
    type: "message.created",
    ...(correlationId !== undefined ? { correlationId } : {}),
    data,
  };
}

/**
 * Build a validated `message.updated` event for an edited `record` (§7.1). Mirrors
 * {@link createdEvent}: the editor's own copy correlates to the request id, the
 * event carries the message's resume `cursor` (so clients can advance their
 * resume position off edits), and the payload is re-validated against the shared
 * `WsMessageUpdated` schema.
 */
function updatedEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId: string,
): OutboundEvent {
  const message = record.message satisfies Message;
  const data = WsMessageUpdatedSchema.shape.data.parse({
    groupId,
    channelId,
    cursor: record.cursor,
    message,
  });
  return { type: "message.updated", correlationId, data };
}

/** Whether `err` is a SQLite UNIQUE-constraint violation (idempotency race). */
function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}
