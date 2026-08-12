/**
 * Direct-message storage + canonical-shape mapping (spec §7.4, §8.3).
 *
 * Owns the `dm_messages` (recipient inbox) and `dm_conversations` (per-inbox
 * summary) row lifecycle, keeping the HTTP/WS layers thin. Authorization
 * (recipient resolution, participant checks) is the caller's responsibility.
 *
 * ## Source of truth (Normative, §8.3)
 * The recipient's home provider is the SOLE authoritative store — there is NO
 * sender copy. A DM is stored only in the recipient's inbox (`dm_messages`,
 * `owner` = the local recipient handle). `GET /api/dms/{dmId}/messages` returns
 * the caller's OWN inbox for the conversation (messages received from the other
 * party). A client that wants to display its own sent messages retains them
 * locally (§7.4).
 *
 * ## The shared seq / cursor contract
 * DM messages reuse the SAME globally-monotonic `seq` space as channel messages
 * (`provider/messages.ts`): `seq = MAX(seq)+1` taken across BOTH `messages` and
 * `dm_messages`. The §7.2 opaque cursor (used by `GET …/messages` paging and the
 * `dm.message` event's `cursor`) is the same `{ seq }` encoding as channel
 * history, so the cursor codec ({@link encodeMessageCursor} /
 * {@link decodeMessageCursor}) is reused directly.
 */
import {
  type Attachment,
  type Content,
  type Message,
  type MessageReference,
  MessageSchema,
  type MetadataList,
  rfc3339Timestamp,
} from "@forumall/shared";
import { and, eq, or, sql } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import {
  type DmConversationRow,
  type DmMessageRow,
  dmConversations,
  dmMessages,
  messages,
} from "../db/schema.ts";
import { type PageDirection, encodeMessageCursor } from "./messages.ts";

/** `id` prefix per the §5.3 wire examples (`msg_…`). */
const MESSAGE_ID_PREFIX = "msg_";
/** Random bytes of entropy for a message id (16 = 128 bits). */
const MESSAGE_ID_BYTES = 16;

/** Default + max page size for the DM history listing (§7.2). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated message id (`msg_<base64url>`). */
function mintMessageId(): string {
  const raw = new Uint8Array(MESSAGE_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${MESSAGE_ID_PREFIX}${toBase64Url(raw)}`;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Map a stored DM row to a canonical, schema-valid `Message` (§5.3). A
 * tombstoned row (`deleted_at` set) keeps its id and carries `deletedAt`. The
 * DM message model carries no group/channel reference — those §5.3 fields are
 * not part of the wire `Message` shape, so the mapping mirrors the channel one.
 */
export function rowToDmMessage(row: DmMessageRow): Message {
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

/** The stored DM record: canonical message + raw seq + opaque cursor. */
export interface DmMessageRecord {
  readonly message: Message;
  readonly seq: number;
  readonly cursor: string;
}

function toRecord(row: DmMessageRow): DmMessageRecord {
  return { message: rowToDmMessage(row), seq: row.seq, cursor: encodeMessageCursor(row.seq) };
}

/** The raw stored DM row for (owner, dmId, id), or `null` if none. */
export function getDmMessageRow(
  db: Db,
  owner: string,
  dmId: string,
  messageId: string,
): DmMessageRow | null {
  return (
    db.drizzle
      .select()
      .from(dmMessages)
      .where(
        and(eq(dmMessages.owner, owner), eq(dmMessages.dmId, dmId), eq(dmMessages.id, messageId)),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Look up an existing inbox message by its idempotency key (§7.1):
 * `(owner, dmId, author, clientMessageId)`. Returns the stored record for the
 * prior delivery, or `null`. Backed by the partial unique index.
 */
export function getDmMessageByClientId(
  db: Db,
  owner: string,
  dmId: string,
  author: string,
  clientMessageId: string,
): DmMessageRecord | null {
  const row =
    db.drizzle
      .select()
      .from(dmMessages)
      .where(
        and(
          eq(dmMessages.owner, owner),
          eq(dmMessages.dmId, dmId),
          eq(dmMessages.author, author),
          eq(dmMessages.clientMessageId, clientMessageId),
        ),
      )
      .limit(1)
      .all()[0] ?? null;
  return row ? toRecord(row) : null;
}

/** Arguments to {@link storeDmMessage}. */
export interface StoreDmMessageInput {
  /** The LOCAL recipient handle whose inbox receives the message. */
  readonly owner: string;
  /** The conversation id (`deriveDmId`, §7.4). */
  readonly dmId: string;
  /** Sending actor (`handle@domain`). */
  readonly author: string;
  readonly content: Content;
  readonly attachments?: Attachment[];
  readonly reference?: MessageReference;
  /** Idempotency key `(owner, dmId, author, clientMessageId)` (§7.1). */
  readonly clientMessageId?: string;
}

/**
 * Store a DM in `owner`'s inbox and upsert the `(owner, dmId)` conversation
 * summary, in one transaction. Assigns the message `id`, `created_at`, the
 * globally-monotonic `seq` (= `MAX(seq)+1` across `messages` ∪ `dm_messages`),
 * and `edit_until` (= `created_at + messageEditWindowSeconds`). Returns the
 * stored {@link DmMessageRecord}. The caller is responsible for recipient
 * resolution + the §8.3 `{dmId}` verification BEFORE calling.
 */
export function storeDmMessage(
  db: Db,
  config: Config,
  input: StoreDmMessageInput,
): DmMessageRecord {
  const now = Date.now();
  const editUntil = now + config.messageEditWindowSeconds * 1000;
  const id = mintMessageId();

  let row!: DmMessageRow;
  db.sqlite.transaction(() => {
    // Global seq across BOTH timelines so the cursor space is shared (§7.2/§7.4).
    const maxRow = db.drizzle
      .select({
        max: sql<
          number | null
        >`(SELECT MAX(seq) FROM (SELECT seq FROM ${messages} UNION ALL SELECT seq FROM ${dmMessages}))`,
      })
      .from(sql`(SELECT 1)`)
      .all()[0];
    const seq = (maxRow?.max ?? 0) + 1;
    row = {
      id,
      dmId: input.dmId,
      owner: input.owner,
      author: input.author,
      content: JSON.stringify(input.content),
      attachments: JSON.stringify(input.attachments ?? []),
      reference: input.reference ? JSON.stringify(input.reference) : null,
      seq,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      editUntil,
      clientMessageId: input.clientMessageId ?? null,
    };
    db.drizzle.insert(dmMessages).values(row).run();
    // Upsert the conversation summary for this inbox.
    db.drizzle
      .insert(dmConversations)
      .values({
        owner: input.owner,
        dmId: input.dmId,
        counterparty: input.author,
        updatedAt: now,
        lastMessageSeq: seq,
      })
      .onConflictDoUpdate({
        target: [dmConversations.owner, dmConversations.dmId],
        set: { counterparty: input.author, updatedAt: now, lastMessageSeq: seq },
      })
      .run();
  })();

  return toRecord(row);
}

// ---------------------------------------------------------------------------
// Conversations (§7.4 listing + participation checks)
// ---------------------------------------------------------------------------

/** The conversation summary row for (owner, dmId), or `null` if absent. */
export function getDmConversationRow(
  db: Db,
  owner: string,
  dmId: string,
): DmConversationRow | null {
  return (
    db.drizzle
      .select()
      .from(dmConversations)
      .where(and(eq(dmConversations.owner, owner), eq(dmConversations.dmId, dmId)))
      .limit(1)
      .all()[0] ?? null
  );
}

/** Whether `owner` is a participant of `dmId` (has an inbox conversation row). */
export function isDmParticipant(db: Db, owner: string, dmId: string): boolean {
  return getDmConversationRow(db, owner, dmId) != null;
}

/**
 * The identity reading a DM thread. `actor` is the full `handle@domain`; `handle`
 * is the bare local handle (only meaningful when `local` is true); `local` is
 * whether the viewer's home provider is THIS provider (so they may own an inbox
 * here). A remote sender reading the recipient's provider has `local === false`
 * and is scoped purely by `author`.
 */
export interface DmViewer {
  /** The viewer's full actor (`handle@domain`) — the `dm_messages.author` key. */
  readonly actor: string;
  /**
   * The viewer's handle **in this provider's namespace**, set only when the
   * viewer is a LOCAL user — it is the `dm_messages.owner` / `dm_conversations.
   * owner` inbox key. `undefined` for a REMOTE viewer (§4.6), whose bare handle
   * belongs to another provider's namespace and must never select an inbox here;
   * a remote viewer is scoped to the rows they AUTHORED. Mirrors
   * `AuthenticatedActor.localHandle` — build it from that, never by splitting the
   * actor string.
   */
  readonly localHandle?: string;
}

/**
 * Whether `viewer` is a participant of `dmId` for the purpose of the broadened
 * read (§7.4). True if the viewer either owns a LOCAL inbox conversation row for
 * `dmId` (received, or a self/same-node conversation), OR is named as the
 * counterparty of SOME local inbox row for `dmId` (covers a cross-provider — or
 * only-sent — sender who has no inbox of their own here but whose sent messages
 * sit in a local recipient's inbox). A true non-participant matches neither.
 */
export function isDmThreadParticipant(db: Db, dmId: string, viewer: DmViewer): boolean {
  if (
    viewer.localHandle !== undefined &&
    getDmConversationRow(db, viewer.localHandle, dmId) != null
  ) {
    return true;
  }
  const row = db.drizzle
    .select({ owner: dmConversations.owner })
    .from(dmConversations)
    .where(and(eq(dmConversations.dmId, dmId), eq(dmConversations.counterparty, viewer.actor)))
    .limit(1)
    .all()[0];
  return row != null;
}

/** Keyset position for the conversation listing: `(updatedAt, dmId)` total order. */
interface ConversationCursor {
  readonly updatedAt: number;
  readonly dmId: string;
}

/** A page of conversation summaries plus the §7.2 cursor pair. */
export interface DmConversationPage {
  readonly items: {
    owner: string;
    dmId: string;
    counterparty: string;
    updatedAt: number;
    lastMessage?: Message;
  }[];
  readonly page: {
    readonly nextCursor?: string;
  };
}

/**
 * List one page of `owner`'s DM conversations, newest-first by `(updatedAt,
 * dmId)` (§7.4). Includes each conversation's last inbox message as
 * `lastMessage`. A malformed `cursor` is treated as the first page.
 */
export function listDmConversations(
  db: Db,
  owner: string,
  opts: { cursor?: string | null; limit?: number } = {},
): DmConversationPage {
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const after = opts.cursor ? decodeConversationCursor(opts.cursor) : null;

  // Keyset predicate: strictly past (updatedAt, dmId) walking DESC.
  // (updatedAt < a) OR (updatedAt = a AND dmId < d).
  const ownerEq = eq(dmConversations.owner, owner);
  const where = after
    ? and(
        ownerEq,
        sql`(${dmConversations.updatedAt} < ${after.updatedAt} OR (${dmConversations.updatedAt} = ${after.updatedAt} AND ${dmConversations.dmId} < ${after.dmId}))`,
      )
    : ownerEq;

  const rows = db.drizzle
    .select()
    .from(dmConversations)
    .where(where)
    .orderBy(sql`${dmConversations.updatedAt} DESC`, sql`${dmConversations.dmId} DESC`)
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items = pageRows.map((row) => {
    const last = lastInboxMessage(db, owner, row.dmId);
    return {
      owner: row.owner,
      dmId: row.dmId,
      counterparty: row.counterparty,
      updatedAt: row.updatedAt,
      ...(last ? { lastMessage: last } : {}),
    };
  });

  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? encodeConversationCursor(last.updatedAt, last.dmId) : undefined;

  return { items, page: { ...(nextCursor !== undefined ? { nextCursor } : {}) } };
}

function encodeConversationCursor(updatedAt: number, dmId: string): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify({ updatedAt, dmId })));
}

function decodeConversationCursor(cursor: string): ConversationCursor | null {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    const pos = JSON.parse(json) as ConversationCursor;
    return typeof pos.updatedAt === "number" && typeof pos.dmId === "string" ? pos : null;
  } catch {
    return null;
  }
}

/** The newest inbox message for (owner, dmId), or undefined for an empty inbox. */
function lastInboxMessage(db: Db, owner: string, dmId: string): Message | undefined {
  const row = db.drizzle
    .select()
    .from(dmMessages)
    .where(and(eq(dmMessages.owner, owner), eq(dmMessages.dmId, dmId)))
    .orderBy(sql`${dmMessages.seq} DESC`)
    .limit(1)
    .all()[0];
  return row ? rowToDmMessage(row) : undefined;
}

// ---------------------------------------------------------------------------
// History (§7.4 reading) — same cursor space + shape as §7.2 channel history.
// ---------------------------------------------------------------------------

/** Options for {@link listDmMessages}. */
export interface ListDmMessagesOptions {
  readonly cursor?: string | null;
  readonly direction?: PageDirection;
  readonly limit?: number;
}

/** A page of DM timeline items plus the §7.2 cursor pair. */
export interface DmMessagePage {
  readonly items: Message[];
  readonly page: {
    readonly nextCursor?: string;
    readonly prevCursor?: string;
  };
}

/**
 * Read one page of the `viewer`'s full conversation view for `dmId` by keyset
 * over `seq` (§7.4, same cursor space + shape as §7.2). The view is the union of
 * the messages the viewer SENT (rows authored by them — which, with no sender
 * copy, live in the counterparty's local inbox) and, when the viewer is local,
 * the messages they RECEIVED (rows in their own inbox). `backward` (default)
 * returns newest-first; `forward` oldest-first. A malformed cursor → first page.
 */
export function listDmMessages(
  db: Db,
  dmId: string,
  viewer: DmViewer,
  opts: ListDmMessagesOptions = {},
): DmMessagePage {
  const direction: PageDirection = opts.direction === "forward" ? "forward" : "backward";
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const after = opts.cursor ? decodeMessageSeqCursor(opts.cursor) : null;

  // Scope: rows authored by the viewer (their SENT messages, stored in the
  // counterparty's inbox) OR — when the viewer is local — rows in the viewer's
  // own inbox (their RECEIVED messages). A self-DM row could satisfy both clauses
  // but it's a single row under OR, so no duplication.
  const scope = and(
    eq(dmMessages.dmId, dmId),
    viewer.localHandle !== undefined
      ? or(eq(dmMessages.author, viewer.actor), eq(dmMessages.owner, viewer.localHandle))
      : eq(dmMessages.author, viewer.actor),
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
  // Stamp the per-item opaque cursor (§7.2/§7.4) so a client can decode each
  // inbox message's `seq` (used by read markers / unread). Forward-compat
  // passthrough field; schemas are additionalProperties:true.
  const items = pageRows.map((row) => ({
    ...rowToDmMessage(row),
    cursor: encodeMessageCursor(row.seq),
  }));

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

/** Decode a §7.2 opaque cursor to its seq, or null. Local copy of the codec. */
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

// ---------------------------------------------------------------------------
// Edit / delete (§7.1 rules applied to the recipient's stored copy)
// ---------------------------------------------------------------------------

/** The cleared content a tombstone carries (mirrors `provider/messages.ts`). */
const TOMBSTONE_CONTENT: Content = { text: "", mime: "text/plain" };

/**
 * Replace an inbox DM's `content` and stamp `edited_at = now` (§7.1 edit). The
 * caller is responsible for authorization (author-only) + the edit-window check
 * BEFORE calling. Returns the updated record. Throws if the row is absent.
 */
export function updateDmMessageContent(
  db: Db,
  owner: string,
  dmId: string,
  messageId: string,
  content: Content,
): DmMessageRecord {
  db.drizzle
    .update(dmMessages)
    .set({ content: JSON.stringify(content), editedAt: Date.now() })
    .where(
      and(eq(dmMessages.owner, owner), eq(dmMessages.dmId, dmId), eq(dmMessages.id, messageId)),
    )
    .run();
  const row = getDmMessageRow(db, owner, dmId, messageId);
  if (!row) throw new Error(`updateDmMessageContent: no such message ${messageId}`);
  return toRecord(row);
}

/**
 * Soft-delete (tombstone) an inbox DM (§7.1): keep its `id`/`seq`, clear
 * `content`, stamp `deleted_at = now`. The caller is responsible for
 * authorization BEFORE calling. Returns the tombstoned record. Throws if absent.
 */
export function tombstoneDmMessage(
  db: Db,
  owner: string,
  dmId: string,
  messageId: string,
): DmMessageRecord {
  db.drizzle
    .update(dmMessages)
    .set({ content: JSON.stringify(TOMBSTONE_CONTENT), deletedAt: Date.now() })
    .where(
      and(eq(dmMessages.owner, owner), eq(dmMessages.dmId, dmId), eq(dmMessages.id, messageId)),
    )
    .run();
  const row = getDmMessageRow(db, owner, dmId, messageId);
  if (!row) throw new Error(`tombstoneDmMessage: no such message ${messageId}`);
  return toRecord(row);
}
