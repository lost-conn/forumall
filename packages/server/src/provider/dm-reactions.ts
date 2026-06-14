/**
 * DM reaction storage + aggregation, and DM reply listing (spec §7.4, mirroring
 * the channel §5.3/§7.1 "Reactions" + §7.2 reply thread).
 *
 * Owns the `dm_reactions` row lifecycle the DM HTTP layer builds on, plus the
 * per-message reaction aggregation embedded onto each DM message on a history
 * read, and the keyset-paginated reply listing for a DM message. Authorization
 * (participant checks, message existence, the §8.3 storage-follows-message
 * routing) is the caller's responsibility — this module owns persistence + shape.
 *
 * ## The one-per-(dm, message, author, key) rule
 * Like channel reactions (`provider/reactions.ts`), a user holds at most ONE
 * reaction per `key` per DM message. {@link addDmReaction} is idempotent against
 * the unique `(dm_id, message_id, author, key)` index: a repeat add returns the
 * EXISTING reaction (same `id`). The canonical `Reaction.reference` is always
 * `{ type: "message", id: <messageId> }`, re-derived from the stored row.
 *
 * ## Aggregate shape (mirrors what the web reuses from channel reactions)
 * {@link reactionsForDmMessage} returns the message's full `Reaction[]` (the same
 * canonical objects the channel reactions listing serves), so the client can
 * aggregate counts exactly as it does for channels.
 */
import {
  type Attachment,
  type Content,
  type Message,
  type MessageReference,
  MessageSchema,
  type MetadataList,
  type Reaction,
  ReactionSchema,
  rfc3339Timestamp,
} from "@forumall/shared";
import { and, eq, or, sql } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type DmMessageRow, type DmReactionRow, dmMessages, dmReactions } from "../db/schema.ts";
import type { DmViewer, ListDmMessagesOptions } from "./dms.ts";
import { type PageDirection, encodeMessageCursor } from "./messages.ts";

/** `id` prefix per the §5.3 wire examples (`rct_…`). */
const REACTION_ID_PREFIX = "rct_";
/** Random bytes of entropy for a reaction id (16 = 128 bits). */
const REACTION_ID_BYTES = 16;

/** Default + max page size for the DM reply listing (§7.2). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated reaction id (`rct_<base64url>`). */
function mintReactionId(): string {
  const raw = new Uint8Array(REACTION_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${REACTION_ID_PREFIX}${toBase64Url(raw)}`;
}

/** Whether `err` is a SQLite UNIQUE-constraint violation (idempotency race). */
function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Map a stored DM-reaction row to the canonical, schema-valid `Reaction` (§5.3).
 * The `reference` is always `{ type: "message", id: <messageId> }`; metadata is
 * an empty list (forward-compatible).
 */
export function rowToDmReaction(row: DmReactionRow): Reaction {
  return ReactionSchema.parse({
    id: row.id,
    author: row.author,
    key: row.key,
    reference: { type: "message", id: row.messageId },
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    metadata: [] as MetadataList,
  });
}

// ---------------------------------------------------------------------------
// Add / remove (idempotent, mirroring channel reactions)
// ---------------------------------------------------------------------------

/** The raw row for (dm, message, author, key), or `null` if no such reaction. */
function getDmReactionRow(
  db: Db,
  dmId: string,
  messageId: string,
  author: string,
  key: string,
): DmReactionRow | null {
  return (
    db.drizzle
      .select()
      .from(dmReactions)
      .where(
        and(
          eq(dmReactions.dmId, dmId),
          eq(dmReactions.messageId, messageId),
          eq(dmReactions.author, author),
          eq(dmReactions.key, key),
        ),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Whether `author` already holds reaction `key` on `(dmId, messageId)`. Used by
 * the REST `PUT` to choose 200 (idempotent repeat) vs 201 (first add).
 */
export function hasDmReaction(
  db: Db,
  dmId: string,
  messageId: string,
  author: string,
  key: string,
): boolean {
  return getDmReactionRow(db, dmId, messageId, author, key) !== null;
}

/** Arguments to {@link addDmReaction}. */
export interface AddDmReactionInput {
  readonly dmId: string;
  readonly messageId: string;
  /** Reacting actor (`handle@domain`). */
  readonly author: string;
  readonly key: string;
}

/**
 * Add `author`'s reaction `key` to a DM message, idempotently. If the user
 * already holds that key on the message, the EXISTING reaction is returned
 * unchanged (same `id`, no duplicate row); otherwise a new row is inserted.
 * Returns the canonical `Reaction`. Authorization (participation, message
 * existence) is the caller's responsibility.
 */
export function addDmReaction(db: Db, input: AddDmReactionInput): Reaction {
  const existing = getDmReactionRow(db, input.dmId, input.messageId, input.author, input.key);
  if (existing) return rowToDmReaction(existing);

  const row: DmReactionRow = {
    id: mintReactionId(),
    dmId: input.dmId,
    messageId: input.messageId,
    author: input.author,
    key: input.key,
    createdAt: Date.now(),
  };
  try {
    db.drizzle.insert(dmReactions).values(row).run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = getDmReactionRow(db, input.dmId, input.messageId, input.author, input.key);
      if (winner) return rowToDmReaction(winner);
    }
    throw err;
  }
  return rowToDmReaction(row);
}

/**
 * Remove `author`'s reaction `key` from a DM message. Returns `true` if a
 * reaction was removed, `false` if none existed (idempotent remove).
 */
export function removeDmReaction(
  db: Db,
  dmId: string,
  messageId: string,
  author: string,
  key: string,
): boolean {
  const existing = getDmReactionRow(db, dmId, messageId, author, key);
  if (!existing) return false;
  db.drizzle
    .delete(dmReactions)
    .where(
      and(
        eq(dmReactions.dmId, dmId),
        eq(dmReactions.messageId, messageId),
        eq(dmReactions.author, author),
        eq(dmReactions.key, key),
      ),
    )
    .run();
  return true;
}

// ---------------------------------------------------------------------------
// Aggregation onto history reads
// ---------------------------------------------------------------------------

/**
 * All reactions on a DM message, ordered by `(created_at, id)` — the canonical
 * `Reaction[]` the client aggregates exactly as for channel reactions.
 */
export function reactionsForDmMessage(db: Db, dmId: string, messageId: string): Reaction[] {
  const rows = db.drizzle
    .select()
    .from(dmReactions)
    .where(and(eq(dmReactions.dmId, dmId), eq(dmReactions.messageId, messageId)))
    .orderBy(dmReactions.createdAt, dmReactions.id)
    .all();
  return rows.map(rowToDmReaction);
}

/**
 * Embed each message's reactions aggregate onto a list of already-mapped DM
 * messages. Attaches a `reactions: Reaction[]` field (only when non-empty) via
 * the passthrough `Message` schema, so the web reuses its channel-reaction
 * rendering. Tombstoned messages keep their `id`, so their reactions still
 * aggregate.
 */
export function withDmReactions(db: Db, dmId: string, items: Message[]): Message[] {
  return items.map((message) => {
    const reactions = reactionsForDmMessage(db, dmId, message.id);
    return reactions.length > 0 ? MessageSchema.parse({ ...message, reactions }) : message;
  });
}

// ---------------------------------------------------------------------------
// Reply listing (§7.2 thread) over the DM inbox timeline
// ---------------------------------------------------------------------------

/** Map a stored DM row to a canonical `Message` (local copy of the dms mapper). */
function rowToDmMessage(row: DmMessageRow): Message {
  const content = JSON.parse(row.content) as Content;
  const attachments = JSON.parse(row.attachments) as Attachment[];
  const reference = row.reference ? (JSON.parse(row.reference) as MessageReference) : undefined;
  return MessageSchema.parse({
    id: row.id,
    author: row.author,
    type: "message",
    content,
    attachments,
    ...(reference ? { reference } : {}),
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    ...(row.editedAt != null ? { editedAt: rfc3339Timestamp(new Date(row.editedAt)) } : {}),
    ...(row.deletedAt != null ? { deletedAt: rfc3339Timestamp(new Date(row.deletedAt)) } : {}),
    permissions: { editUntil: rfc3339Timestamp(new Date(row.editUntil)) },
    metadata: [] as MetadataList,
  });
}

/** Decode a §7.2 opaque cursor to its seq, or null (local copy of the codec). */
function decodeMessageSeqCursor(cursor: string): number | null {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    const pos = JSON.parse(json) as { seq?: unknown };
    return typeof pos.seq === "number" ? pos.seq : null;
  } catch {
    return null;
  }
}

/** A page of DM reply items plus the §7.2 cursor pair. */
export interface DmReplyPage {
  readonly items: Message[];
  readonly page: {
    readonly nextCursor?: string;
    readonly prevCursor?: string;
  };
}

/**
 * List one page of the replies to `parentMessageId` within the `viewer`'s full
 * conversation view for `dmId` (§7.2), mirroring channel {@link listReplies}: the
 * DM messages whose `reference.id` is `parentMessageId` and `reference.type` is
 * `reply`, over the same `seq` cursor space, scoped to the same union as
 * {@link listDmMessages} (sent ∪, when local, received). `direction` defaults to
 * `forward` (oldest-reply-first). Reactions are embedded onto each reply.
 * Authorization (participation) is the caller's responsibility.
 */
export function listDmReplies(
  db: Db,
  dmId: string,
  parentMessageId: string,
  viewer: DmViewer,
  opts: ListDmMessagesOptions = {},
): DmReplyPage {
  const direction: PageDirection = opts.direction === "backward" ? "backward" : "forward";
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const after = opts.cursor ? decodeMessageSeqCursor(opts.cursor) : null;

  // Replies: same dm, whose JSON reference is a reply to the parent, scoped to
  // the viewer's sent ∪ (local ? received) union — matching listDmMessages.
  const scope = and(
    eq(dmMessages.dmId, dmId),
    viewer.local
      ? or(eq(dmMessages.author, viewer.actor), eq(dmMessages.owner, viewer.handle))
      : eq(dmMessages.author, viewer.actor),
    sql`json_valid(${dmMessages.reference}) AND json_extract(${dmMessages.reference}, '$.type') = 'reply' AND json_extract(${dmMessages.reference}, '$.id') = ${parentMessageId}`,
  );
  const where =
    after != null
      ? and(
          scope,
          direction === "forward"
            ? sql`${dmMessages.seq} > ${after}`
            : sql`${dmMessages.seq} < ${after}`,
        )
      : scope;

  const rows = db.drizzle
    .select()
    .from(dmMessages)
    .where(where)
    .orderBy(direction === "forward" ? sql`${dmMessages.seq} ASC` : sql`${dmMessages.seq} DESC`)
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = withDmReactions(db, dmId, pageRows.map(rowToDmMessage));

  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeMessageCursor(last.seq) : undefined;
  const prevCursor = first ? encodeMessageCursor(first.seq) : undefined;

  return {
    items,
    page: {
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(prevCursor !== undefined ? { prevCursor } : {}),
    },
  };
}
