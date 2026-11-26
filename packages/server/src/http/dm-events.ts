/**
 * DM real-time events (§7.4): `dm.message` / `dm.reaction` / `dm.conversation`
 * payload builders and fan-out, and the stored-copy edit/delete that emit them
 * (§7.1 rules).
 */
import {
  type Attachment,
  type DmConversation,
  DmConversationSchema,
  type Message,
  type Reaction,
  WsDmMessageSchema,
  WsDmReactionSchema,
  rfc3339Timestamp,
} from "@forumall/shared";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { tombstoneDmMessage, updateDmMessageFields } from "../provider/dm-edits.ts";
import { getDmConversationItem } from "../provider/dms.ts";
import type { Hub } from "../provider/ws-hub.ts";
import { domainOf } from "./dm-request.ts";
import { AppError } from "./errors.ts";
import { resolveMessageEdit } from "./message-edit.ts";

/**
 * Build the `data` payload of a `dm.message` event for a stored record (§7.4),
 * validated against `WsDmMessageSchema`: the `dmId`, the message's opaque
 * `cursor`, and the full canonical `Message` — the same object
 * `GET /api/dms/{dmId}/messages` returns, carrying the delivery's
 * `clientMessageId` so the recipient's devices can de-dupe.
 */
export function dmMessageEventData(dmId: string, cursor: string, message: Message): unknown {
  return WsDmMessageSchema.shape.data.parse({ dmId, cursor, message });
}

/** Build a validated `dm.reaction` event payload (added/removed). */
function dmReactionEventData(args: {
  dmId: string;
  messageId: string;
  state: "added" | "removed";
  author: string;
  key: string;
  reaction?: Reaction;
}): unknown {
  return WsDmReactionSchema.shape.data.parse({
    dmId: args.dmId,
    messageId: args.messageId,
    state: args.state,
    author: args.author,
    key: args.key,
    ...(args.reaction ? { reaction: args.reaction } : {}),
  });
}

/** The hub surface the DM routes use for fan-out (publish to a specific actor). */
type DmHub = { publishToActor(actor: string, event: { type: string; data: unknown }): void };

/**
 * Fan out a `dm.reaction` event to BOTH participants of the conversation
 * (mirroring the `publishToActor`-per-participant DM-send delivery). Dedupes so
 * a fully-local both-parties pair isn't notified twice.
 */
export function fanOutDmReaction(
  hub: DmHub,
  args: {
    dmId: string;
    messageId: string;
    state: "added" | "removed";
    author: string;
    key: string;
    reaction?: Reaction;
    participants: string[];
  },
): void {
  const data = dmReactionEventData({
    dmId: args.dmId,
    messageId: args.messageId,
    state: args.state,
    author: args.author,
    key: args.key,
    ...(args.reaction ? { reaction: args.reaction } : {}),
  });
  for (const actor of new Set(args.participants)) {
    hub.publishToActor(actor, { type: "dm.reaction", data });
  }
}

/**
 * Apply an edit to a stored inbox DM, then fan `dm.message` to the inbox owner.
 * Shared by the local PATCH path and the federation ingest so both enforce
 * identical §7.1 rules, in order: `row` is the pre-fetched stored row (already
 * asserted to exist, else the caller's 404); a 403 if the acting actor is not
 * the author or the edit window has passed; only then the `MessageUpdate`
 * `body` ({@link resolveMessageEdit}: 400 when it breaks a rule). A DM is never
 * an `article`, so article fields alone are a 400 and otherwise ignored.
 */
export function applyDmEdit(
  db: Db,
  config: Config,
  hub: DmHub,
  args: {
    owner: string;
    ownerActor: string;
    dmId: string;
    messageId: string;
    actor: string;
    /** The `MessageUpdate` body as received; checked after authorization. */
    body: unknown;
    row: { author: string; editUntil: number; attachments: string };
  },
): Message {
  if (args.row.author !== args.actor) {
    throw AppError.forbidden({ detail: "only the author may edit this message" });
  }
  if (Date.now() > args.row.editUntil) {
    throw AppError.forbidden({ detail: "the edit window for this message has passed" });
  }
  const target = {
    type: "message" as const,
    attachments: JSON.parse(args.row.attachments) as Attachment[],
    cover: null,
  };
  const edit = resolveMessageEdit(db, config, args.actor, target, args.body);
  if (edit.error) throw AppError.badRequest({ detail: edit.error.message });
  const record = updateDmMessageFields(db, args.owner, args.dmId, args.messageId, edit.patch);
  hub.publishToActor(args.ownerActor, {
    type: "dm.message",
    data: dmMessageEventData(args.dmId, record.cursor, record.message),
  });
  return record.message;
}

/**
 * Tombstone a stored inbox DM, then fan `dm.message` to the inbox owner. Shared
 * by the local DELETE path and the federation ingest.
 *
 * `requireAuthor` controls the §7.1 authorization: it is `false` for the local
 * own-inbox path (the inbox owner may delete their OWN stored copy — preserving
 * the original DM-delete semantics where a recipient can tombstone a received
 * message in their inbox), and `true` for the forwarded / federation-ingest path
 * (a sender deleting a message they SENT that lives in the counterparty's inbox
 * — only the ORIGINAL AUTHOR may do so; else 403).
 */
export function applyDmDelete(
  db: Db,
  hub: DmHub,
  args: {
    owner: string;
    ownerActor: string;
    dmId: string;
    messageId: string;
    actor: string;
    row: { author: string };
    requireAuthor: boolean;
  },
): void {
  if (args.requireAuthor && args.row.author !== args.actor) {
    throw AppError.forbidden({ detail: "only the author may delete this message" });
  }
  const record = tombstoneDmMessage(db, args.owner, args.dmId, args.messageId);
  hub.publishToActor(args.ownerActor, {
    type: "dm.message",
    data: dmMessageEventData(args.dmId, record.cursor, record.message),
  });
}

/** Render a conversation-list item as the wire `DmConversation` for `ownerActor`. */
export function wireConversation(
  ownerActor: string,
  conv: { dmId: string; counterparty: string; updatedAt: number; lastMessage?: Message },
): DmConversation {
  return DmConversationSchema.parse({
    id: conv.dmId,
    participants: [ownerActor, conv.counterparty],
    ...(conv.lastMessage ? { lastMessage: conv.lastMessage } : {}),
    updatedAt: rfc3339Timestamp(new Date(conv.updatedAt)),
    metadata: [],
  });
}

/**
 * Emit `dm.conversation` (§7.4) with the owner's current view of `dmId` to all
 * of the owner's connections, and return that conversation.
 */
export function publishDmConversation(
  hub: Hub,
  db: Db,
  ownerActor: string,
  ownerHandle: string,
  dmId: string,
): DmConversation | null {
  const item = getDmConversationItem(db, ownerHandle, dmId, domainOf(ownerActor));
  if (!item) return null;
  const conversation = wireConversation(ownerActor, item);
  hub.publishToActor(ownerActor, { type: "dm.conversation", data: { conversation } });
  return conversation;
}
