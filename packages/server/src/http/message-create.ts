/**
 * §7.1 message creation, shared by the WS `message.create` command
 * (`http/ws/messages.ts`) and `POST /api/groups/{groupId}/channels/{channelId}/messages`
 * (`http/messages.ts`). Both take the `MessageCreate` body and run the same
 * ordered checks, idempotency, storage and fan-out; only how the answer reaches
 * the client differs (an `error` / `message.created` frame vs. an HTTP status).
 *
 * ## Order of checks (§7.1)
 *  1. Authentication is the caller's (signature / authenticated connection).
 *     Here: the body must be an object whose `clientMessageId` and `type` match
 *     the schema, since the steps below need them → 400.
 *  2. Visibility: missing group/channel, or one the actor cannot read → 404.
 *  3. `post:<type>` (omitted `type` = `message`) and, for a reply-restricted
 *     actor, the presence of a `reference` → 403.
 *  4. Duplicate lookup on `(author, channelId, clientMessageId)`: an existing
 *     message is answered as it now stands, and nothing below is checked,
 *     stored or fanned out.
 *  5. For a new message only: the full `MessageCreate` schema (content,
 *     attachments, tags, metadata), a `reference` that is a reply to a message
 *     in this channel → 400; then `replyOnlyTo` → 403.
 */
import {
  type Message,
  MessageCreateRequestSchema,
  MessageKindSchema,
  WsMessageCreatedSchema,
} from "@forumall/shared";
import { z } from "zod";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { FederationFetch } from "../provider/federation/http.ts";
import { fireMessageNotifications } from "../provider/message-notifications.ts";
import { type MessageRecord, createMessage, getMessageByClientId } from "../provider/messages.ts";
import { deliverNotification, groupMemberActors } from "../provider/notifications.ts";
import type { CorrelatedReply, Hub, OutboundEvent } from "../provider/ws-hub.ts";
import {
  type MutationError,
  authorizePostAccess,
  authorizeReplyTarget,
} from "./message-mutations.ts";

/** What a create needs from the app (both transports have all of it). */
export interface MessageCreateDeps {
  readonly config: Config;
  readonly db: Db;
  readonly hub: Hub;
  readonly federationFetch: FederationFetch;
}

/** The target channel, the authenticated author and the raw `MessageCreate` body. */
export interface MessageCreateInput {
  readonly groupId: string;
  readonly channelId: string;
  /** The authenticated actor; any `author` in the body is ignored. */
  readonly author: string;
  /** The `MessageCreate` body as received (WS `data` may also carry the ids). */
  readonly body: unknown;
  /**
   * The WS command that asked for the create: the requesting connection gets
   * its `message.created` with the command id in `correlationId`, every other
   * subscriber an uncorrelated copy. Absent for a REST create, whose
   * `message.created` has no `correlationId` at all (§7.1).
   */
  readonly reply?: CorrelatedReply;
}

/**
 * The answer to a create: a new message (`created`, already fanned out), the
 * existing one for a duplicate `clientMessageId` (`duplicate`, NOT fanned out —
 * the caller answers only the requester), or a structured rejection.
 */
export type MessageCreateOutcome =
  | { readonly kind: "created"; readonly record: MessageRecord }
  | { readonly kind: "duplicate"; readonly record: MessageRecord }
  | { readonly kind: "rejected"; readonly error: MutationError };

/** Step 1: the fields the ordered checks need before the full body is checked. */
const CreateKeySchema = z
  .object({
    clientMessageId: z.string().min(1).optional(),
    type: MessageKindSchema.optional(),
  })
  .passthrough();

function badRequest(message: string): MessageCreateOutcome {
  return { kind: "rejected", error: { code: "bad_request", message } };
}

/** Run a §7.1 create end to end (see the module doc for the order of checks). */
export function createChannelMessage(
  deps: MessageCreateDeps,
  input: MessageCreateInput,
): MessageCreateOutcome {
  const { config, db, hub } = deps;
  const { groupId, channelId, author } = input;

  // 1. clientMessageId + type, readable before anything else.
  const key = CreateKeySchema.safeParse(input.body);
  if (!key.success) return badRequest("invalid clientMessageId or type");
  const { clientMessageId } = key.data;
  const type = key.data.type ?? "message";
  const hasReference = (input.body as { reference?: unknown }).reference !== undefined;

  // 2–3. Visibility (404), then post:<type> + reply-only presence (403).
  const access = authorizePostAccess(db, groupId, channelId, author, type, hasReference);
  if (access.error) return { kind: "rejected", error: access.error };

  // 4. Duplicate: the existing message as it now stands; nothing else applies.
  if (clientMessageId !== undefined) {
    const existing = getMessageByClientId(db, author, channelId, clientMessageId);
    if (existing) return { kind: "duplicate", record: existing };
  }

  // 5. The full body, the reply target and replyOnlyTo — new messages only.
  const parsed = MessageCreateRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    return badRequest(`invalid message body${where}`);
  }
  const body = parsed.data;
  const replyError = authorizeReplyTarget(db, channelId, access.grant, body.reference);
  if (replyError) return { kind: "rejected", error: replyError };

  let record: MessageRecord;
  try {
    record = createMessage(db, config, {
      channelId,
      groupId,
      author,
      type,
      content: body.content,
      ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      ...(body.reference !== undefined ? { reference: body.reference } : {}),
      ...(body.tags !== undefined && body.tags.length > 0 ? { tags: body.tags } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      ...(clientMessageId !== undefined ? { clientMessageId } : {}),
    });
  } catch (err) {
    // Idempotency race: a concurrent create won the unique
    // (author, channelId, clientMessageId) index — answer with its row.
    if (clientMessageId !== undefined && isUniqueViolation(err)) {
      const winner = getMessageByClientId(db, author, channelId, clientMessageId);
      if (winner) return { kind: "duplicate", record: winner };
    }
    throw err;
  }

  // Fan out to every subscriber, the author's connections included; only the
  // requesting connection's copy is correlated to its command (§7.1).
  hub.publishToChannel(channelId, createdEvent(groupId, channelId, record), input.reply);
  fireMessageCreatedNotifications(deps, groupId, channelId, record, author);
  fireMessageNotifications(db, config, hub, {
    text: body.content.text,
    author,
    sourceMessageId: record.message.id,
    channelId,
    groupId,
    ...(body.reference !== undefined ? { replyToId: body.reference.id } : {}),
  });
  return { kind: "created", record };
}

/**
 * Build a validated `message.created` timeline event for `record`: the full
 * canonical message (§5.3) plus its opaque `cursor` on `data` (§7.1 resume /
 * §7.2 history share one cursor space). `correlationId` is for a frame sent to
 * one connection only (a resume replay carries its `subscribe` command id); the
 * live fan-out passes none and lets {@link Hub.publishToChannel} correlate the
 * requesting connection's copy.
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
 * The `message.created` answering a duplicate WS create (§7.1): sent only to the
 * requesting connection, correlated to its command, and WITHOUT a `cursor` — it
 * is not a timeline event, so clients must not store it as a resume point. The
 * message is as it now stands (possibly edited or a tombstone).
 */
export function duplicateCreatedEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId: string,
): OutboundEvent {
  const data = WsMessageCreatedSchema.shape.data.parse({
    groupId,
    channelId,
    message: record.message,
  });
  return { type: "message.created", correlationId, data };
}

/**
 * §10 fan-out hook for `message.created`. Non-blocking: builds the owner filter
 * (group members minus the author) and hands off to {@link deliverNotification}
 * without awaiting, logging any rejection. A group with no subscribed endpoints
 * resolves to an empty result (no outbound requests).
 */
function fireMessageCreatedNotifications(
  deps: MessageCreateDeps,
  groupId: string,
  channelId: string,
  record: MessageRecord,
  author: string,
): void {
  const { config, db, federationFetch } = deps;
  const ownerFilter = groupMemberActors(db, groupId, author);
  void deliverNotification(db, config, federationFetch, {
    event: "message.created",
    resource: { id: record.message.id, channel: channelId },
    ownerFilter,
  }).catch((err) => {
    console.error("notification delivery (message.created) failed:", err);
  });
}

/** Whether `err` is a SQLite UNIQUE-constraint violation (idempotency race). */
function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}
