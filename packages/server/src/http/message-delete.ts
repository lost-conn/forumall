/**
 * Message delete (§7.1 "Deleting", "Edits and deletes of a tombstone"), shared
 * by the WS `message.delete` command (`http/ws/messages.ts`) and the REST
 * `DELETE …/messages/{messageId}` route (`http/messages.ts`), plus the
 * `message.deleted` event builders (also used by the resume replay,
 * `http/ws/subscriptions.ts`).
 *
 * The order of checks is {@link authorizeMessageDelete}'s (visibility 404, the
 * message 404, author-or-`moderate` 403), then step 5: a delete of a message
 * that is already a tombstone changes nothing and fans out nothing. Over REST
 * it is `204` like any delete; over WebSocket the requesting connection alone
 * gets {@link repeatDeletedEvent}.
 */
import { WsMessageDeletedSchema, rfc3339Timestamp } from "@forumall/shared";

import type { Db } from "../db/index.ts";
import { type MessageRecord, rowToRecord, tombstoneMessage } from "../provider/messages.ts";
import type { CorrelatedReply, Hub, OutboundEvent } from "../provider/ws-hub.ts";
import { type MutationError, authorizeMessageDelete } from "./message-mutations.ts";

/** What {@link deleteChannelMessage} needs to know about the request. */
export interface DeleteMessageInput {
  readonly groupId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly actor: string;
  /** The WS command being answered: its connection gets the correlated copy. */
  readonly reply?: CorrelatedReply;
}

/**
 * The outcome of a delete: refused, a fresh tombstone (already fanned out), or
 * a repeated delete of an existing tombstone (nothing changed or fanned out).
 */
export type DeleteMessageOutcome =
  | { readonly kind: "rejected"; readonly error: MutationError }
  | { readonly kind: "deleted"; readonly record: MessageRecord }
  | { readonly kind: "already_deleted"; readonly record: MessageRecord };

/**
 * Delete (tombstone) a channel message for `input.actor`, in the §7.1 order of
 * checks. A fresh delete stores the tombstone and fans `message.deleted` out to
 * the channel's subscribers, `input.reply`'s connection getting the one
 * correlated copy (§7.1 "The requester's own copy"). A repeated delete leaves
 * the tombstone as it is and fans out nothing; the caller answers it.
 */
export function deleteChannelMessage(
  db: Db,
  hub: Hub,
  input: DeleteMessageInput,
): DeleteMessageOutcome {
  const { groupId, channelId, messageId, actor } = input;
  const outcome = authorizeMessageDelete(db, groupId, channelId, messageId, actor);
  if (outcome.error) return { kind: "rejected", error: outcome.error };
  if (outcome.row.deletedAt !== null) {
    return { kind: "already_deleted", record: rowToRecord(outcome.row) };
  }
  const record = tombstoneMessage(db, channelId, messageId);
  hub.publishToChannel(channelId, deletedEvent(groupId, channelId, record), input.reply);
  return { kind: "deleted", record };
}

/** The `deletedAt` of a tombstone record, as RFC 3339. */
function deletedAtOf(record: MessageRecord): string {
  return record.message.deletedAt ?? rfc3339Timestamp();
}

/**
 * A validated `message.deleted` timeline event for a tombstone `record`,
 * carrying the message's `cursor` (§7.1 resume / §7.2 history share one cursor
 * space). `correlationId` is for a frame sent to one connection only (a resume
 * replay carries its `subscribe` command id); a live fan-out passes none and
 * lets {@link Hub.publishToChannel} correlate the requester's copy.
 */
export function deletedEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId?: string,
): OutboundEvent {
  const data = WsMessageDeletedSchema.shape.data.parse({
    groupId,
    channelId,
    messageId: record.message.id,
    cursor: record.cursor,
    deletedAt: deletedAtOf(record),
  });
  return {
    type: "message.deleted",
    ...(correlationId !== undefined ? { correlationId } : {}),
    data,
  };
}

/**
 * The `message.deleted` answering a repeated WS delete (§7.1 step 5): sent to
 * the requesting connection alone, correlated to its command, and WITHOUT a
 * `cursor` — like the answer to a duplicate create, it is not a timeline event
 * and clients must not store it as a resume point.
 */
export function repeatDeletedEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId: string,
): OutboundEvent {
  const data = WsMessageDeletedSchema.shape.data.parse({
    groupId,
    channelId,
    messageId: record.message.id,
    deletedAt: deletedAtOf(record),
  });
  return { type: "message.deleted", correlationId, data };
}
