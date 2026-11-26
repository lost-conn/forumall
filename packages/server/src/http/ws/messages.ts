/**
 * §7.1 message commands — `message.create` (via the create logic shared with
 * REST, `http/message-create.ts`), `message.update` and `message.delete` — and
 * the `message.updated` event builder.
 */
import {
  type Message,
  WsMessageDeleteSchema,
  WsMessageDeletedSchema,
  WsMessageUpdatedSchema,
  rfc3339Timestamp,
} from "@forumall/shared";
import { z } from "zod";
import { type MessageRecord, tombstoneMessage } from "../../provider/messages.ts";
import type { OutboundEvent } from "../../provider/ws-hub.ts";
import { createChannelMessage, duplicateCreatedEvent } from "../message-create.ts";
import { editChannelMessage } from "../message-edit.ts";
import { authorizeMessageDelete } from "../message-mutations.ts";
import { type ConnState, type WsContext, type WsCtx, errorEvent } from "./connection.ts";

/** The `message.create` target: `groupId` / `channelId` beside the body. */
const CreateTargetSchema = z.object({
  data: z.object({ groupId: z.string().min(1), channelId: z.string().min(1) }).passthrough(),
});

/**
 * The `message.update` target: `groupId` / `channelId` / `messageId` beside the
 * `MessageUpdate` body, which `editChannelMessage` checks after authorizing.
 */
const UpdateTargetSchema = z.object({
  data: z
    .object({
      groupId: z.string().min(1),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
    })
    .passthrough(),
});

/**
 * §7.1 Sending messages: `data` is the `MessageCreate` body plus `groupId` and
 * `channelId`. The shared {@link createChannelMessage} runs the ordered checks,
 * idempotency, storage and fan-out (to every subscriber, the author's
 * connections included; only this connection's copy is correlated to the
 * command). A rejection is an `error`
 * frame correlated to the command; a duplicate `clientMessageId` answers only
 * this connection with the existing message (no `cursor`, no re-fan-out).
 *
 * The author is ALWAYS the connection's authenticated actor; any `author` in
 * the client payload is ignored.
 */
export function handleMessageCreate(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { hub } = ctx;
  const author = state.actor;
  if (!state.hubConn || !author) return; // unreachable: only authenticated connections reach here

  const target = CreateTargetSchema.safeParse(rawFrame);
  if (!target.success) {
    hub.send(ws, errorEvent("bad_request", "malformed message.create command", frameId));
    return;
  }
  const { groupId, channelId } = target.data.data;
  const outcome = createChannelMessage(ctx, {
    groupId,
    channelId,
    author,
    body: target.data.data,
    reply: { conn: state.hubConn, correlationId: frameId },
  });
  if (outcome.kind === "rejected") {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
  } else if (outcome.kind === "duplicate") {
    hub.send(ws, duplicateCreatedEvent(groupId, channelId, outcome.record, frameId));
  }
}

/**
 * §7.1 Editing messages: `data` is the `MessageUpdate` plus the target ids;
 * each field present replaces the stored one (`http/message-edit.ts`). Missing
 * message / wrong channel/group → 404; not the author or the window passed →
 * 403; only then a body breaking a rule → 400. On success stamp `edited_at` and
 * fan out `message.updated` with the full message to every channel subscriber
 * (only the editing connection's copy correlates to the request id).
 */
export function handleMessageUpdate(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { db, config, hub } = ctx;
  // Only the target ids first: the edit itself is judged (400) after the
  // message is found (404) and the actor may edit it (403).
  const target = UpdateTargetSchema.safeParse(rawFrame);
  if (!target.success) {
    hub.send(ws, errorEvent("bad_request", "malformed message.update command", frameId));
    return;
  }
  const actor = state.actor;
  const hubConn = state.hubConn;
  if (!actor || !hubConn) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId } = target.data.data;
  const outcome = editChannelMessage(db, config, {
    groupId,
    channelId,
    messageId,
    actor,
    body: target.data.data,
  });
  if (outcome.error) {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
    return;
  }

  const { record } = outcome;
  hub.publishToChannel(channelId, updatedEvent(groupId, channelId, record), {
    conn: hubConn,
    correlationId: frameId,
  });
}

/**
 * §7.1 Deleting messages: tombstone (soft-delete) a message — keep `id`/`seq`,
 * clear `content`, set `deleted_at`. The **author** OR a member with the
 * `moderate` role may delete. On success fan out `message.deleted` (only the
 * deleting connection's copy correlates to the request id, §7.1). Missing
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
  const hubConn = state.hubConn;
  if (!actor || !hubConn) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId } = parsed.data.data;
  const outcome = authorizeMessageDelete(db, groupId, channelId, messageId, actor);
  if (outcome.error) {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
    return;
  }

  const record = tombstoneMessage(db, channelId, messageId);
  const deletedAt = record.message.deletedAt ?? rfc3339Timestamp();
  hub.publishToChannel(
    channelId,
    {
      type: "message.deleted",
      data: WsMessageDeletedSchema.shape.data.parse({
        groupId,
        channelId,
        messageId,
        cursor: record.cursor,
        deletedAt,
      }),
    },
    { conn: hubConn, correlationId: frameId },
  );
}
/**
 * Build a validated `message.updated` event for an edited `record` (§7.1). Mirrors
 * {@link createdEvent}: uncorrelated here — the caller's fan-out correlates only
 * the editing connection's copy to the request id. The event carries the message's resume `cursor` (so clients can advance their
 * resume position off edits), and the payload is re-validated against the shared
 * `WsMessageUpdated` schema.
 */
function updatedEvent(groupId: string, channelId: string, record: MessageRecord): OutboundEvent {
  const message = record.message satisfies Message;
  const data = WsMessageUpdatedSchema.shape.data.parse({
    groupId,
    channelId,
    cursor: record.cursor,
    message,
  });
  return { type: "message.updated", data };
}
