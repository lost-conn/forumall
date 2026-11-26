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
  canonicalActor,
  deriveDmId,
  rfc3339Timestamp,
} from "@forumall/shared";
import { and, eq, sql } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import {
  type DmConversationRow,
  type DmMessageRow,
  dmConversations,
  dmMessages,
  messages,
} from "../db/schema.ts";
import { encodeMessageCursor } from "./messages.ts";

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
    // Echo of the delivery's idempotency key (§7.1, §7.4): MUST be on the send
    // response (first or duplicate); also carried by `dm.message` and history.
    ...(row.clientMessageId != null ? { clientMessageId: row.clientMessageId } : {}),
    author: row.author,
    // The v0.1 DM body carries no `type`; a DM is always a `message` (§7.4).
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

/**
 * Whether a stored conversation row is CONSISTENT (OFSCP §7.4 pointer hygiene):
 * its counterparty is (or canonicalizes to) an actor that derives the row's
 * `dmId` together with `ownerActor`. A pointer's counterparty is fixed by its
 * `dmId`; a row that fails this — e.g. one recorded before `PUT /api/me/dms`
 * enforced the derivation, or a counterparty that cannot be made canonical — is
 * IGNORED everywhere: neither listed (`GET /api/me/dms`, unread summary) nor
 * acted on (participation, read markers, typing, reaction/edit/delete forwards).
 * Migration 0036 deletes the rows already stored this way, and guest
 * claim/merge delete any they meet; at read time we ignore rather than delete so
 * a read never writes. The next valid write for the same `(owner, dmId)` (an
 * inbox message or a pointer PUT) replaces it.
 */
export function conversationDerivesDmId(
  ownerActor: string,
  row: { readonly dmId: string; readonly counterparty: string },
): boolean {
  const counterparty = canonicalActor(row.counterparty);
  return counterparty !== null && deriveDmId(ownerActor, counterparty) === row.dmId;
}

/**
 * The CONSISTENT conversation summary row for (owner, dmId), or `null` if absent
 * or ignored by {@link conversationDerivesDmId}. `domain` is this provider's
 * canonical authority (the local owner's actor is `owner@domain`).
 */
export function getDmConversationRow(
  db: Db,
  owner: string,
  dmId: string,
  domain: string,
): DmConversationRow | null {
  const row = db.drizzle
    .select()
    .from(dmConversations)
    .where(and(eq(dmConversations.owner, owner), eq(dmConversations.dmId, dmId)))
    .limit(1)
    .all()[0];
  return row && conversationDerivesDmId(`${owner}@${domain}`, row) ? row : null;
}

/** Whether `owner` is a participant of `dmId` (has a consistent conversation row). */
export function isDmParticipant(db: Db, owner: string, dmId: string, domain: string): boolean {
  return getDmConversationRow(db, owner, dmId, domain) != null;
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
export function isDmThreadParticipant(
  db: Db,
  dmId: string,
  viewer: DmViewer,
  domain: string,
): boolean {
  if (
    viewer.localHandle !== undefined &&
    getDmConversationRow(db, viewer.localHandle, dmId, domain) != null
  ) {
    return true;
  }
  return db.drizzle
    .select()
    .from(dmConversations)
    .where(and(eq(dmConversations.dmId, dmId), eq(dmConversations.counterparty, viewer.actor)))
    .all()
    .some((row) => conversationDerivesDmId(`${row.owner}@${domain}`, row));
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
 * `lastMessage`. A malformed `cursor` is treated as the first page. Rows ignored
 * by {@link conversationDerivesDmId} are skipped (the page may then be short;
 * the cursor still advances past them).
 */
export function listDmConversations(
  db: Db,
  owner: string,
  domain: string,
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

  const ownerActor = `${owner}@${domain}`;
  const items = pageRows
    .filter((row) => conversationDerivesDmId(ownerActor, row))
    .map((row) => conversationItem(db, row));

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

/**
 * One conversation-list item for a `dm_conversations` row: its newest message
 * is the later of the newest RECEIVED message (authoritative, in this inbox)
 * and the cached newest SENT message from a conversation pointer (§7.4).
 *
 * "Later" is decided by times THIS provider recorded — when it stored the
 * received message (`dm_messages.created_at`) and when it stored the cached
 * preview (`last_sent_at`) — never by the client-supplied `createdAt` inside the
 * cached preview, which the client can forge to pin the conversation's preview.
 * On a tie the received message wins. A legacy row whose preview predates
 * `last_sent_at` (NULL) has no trustworthy store time, so it loses to any
 * received message and is shown only when the inbox is empty.
 */
function conversationItem(db: Db, row: DmConversationRow) {
  const received = lastInboxRow(db, row.owner, row.dmId);
  const sent = parseCachedMessage(row.lastSentMessage);
  const sentWins =
    sent !== undefined &&
    (received === undefined || (row.lastSentAt != null && row.lastSentAt > received.createdAt));
  const last = sentWins ? sent : received ? rowToDmMessage(received) : undefined;
  return {
    owner: row.owner,
    dmId: row.dmId,
    // Served canonically (§7.4); callers only pass consistent rows, whose
    // counterparty canonicalizes.
    counterparty: canonicalActor(row.counterparty) ?? row.counterparty,
    updatedAt: row.updatedAt,
    ...(last ? { lastMessage: last } : {}),
  };
}

function parseCachedMessage(json: string | null | undefined): Message | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Message;
  } catch {
    return undefined;
  }
}

/**
 * Re-point a cached pointer preview's `author` from `from` to `to` (guest claim
 * / merge re-key the owner's actor). Returns the JSON unchanged when it is
 * absent, unparseable, or authored by someone else.
 */
export function rekeyCachedMessageAuthor(
  json: string | null,
  from: string,
  to: string,
): string | null {
  const msg = parseCachedMessage(json);
  return msg && msg.author === from ? JSON.stringify({ ...msg, author: to }) : json;
}

/** The conversation-list item for (owner, dmId), or `null` if there is none. */
export function getDmConversationItem(db: Db, owner: string, dmId: string, domain: string) {
  const row = getDmConversationRow(db, owner, dmId, domain);
  return row ? conversationItem(db, row) : null;
}

/**
 * Record a conversation POINTER for the local owner `ownerActor`
 * (`handle@<thisDomain>`, OFSCP §7.4): the owner has a conversation `dmId` with
 * `counterparty`, optionally caching the message they just sent
 * (non-authoritative; the real copy is in the counterparty's inbox).
 * Creates the row if absent (with no inbox message, `lastMessageSeq` 0) and
 * bumps `updatedAt` (server time) so the conversation sorts by latest activity.
 * `lastSentAt` records when the cached preview was stored. Never touches
 * `lastMessageSeq`, which tracks this inbox only.
 *
 * Refuses (records nothing, returns `false`) unless `counterparty` canonicalizes
 * and derives `dmId` together with the owner — a pointer's counterparty is fixed
 * by its dmId (§7.4). Callers verify this too; this is the storage-level guard.
 */
export function upsertDmPointer(
  db: Db,
  ownerActor: string,
  dmId: string,
  counterparty: string,
  lastSent?: Message,
): boolean {
  // Stored (and served) in canonical form (§7.4).
  const canonicalCounterparty = canonicalActor(counterparty);
  if (
    canonicalCounterparty === null ||
    !conversationDerivesDmId(ownerActor, { dmId, counterparty: canonicalCounterparty })
  ) {
    return false;
  }
  const owner = ownerActor.slice(0, ownerActor.lastIndexOf("@"));
  const now = Date.now();
  const cached = lastSent ? JSON.stringify(lastSent) : null;
  db.drizzle
    .insert(dmConversations)
    .values({
      owner,
      dmId,
      counterparty: canonicalCounterparty,
      updatedAt: now,
      lastMessageSeq: 0,
      lastSentMessage: cached,
      lastSentAt: cached !== null ? now : null,
    })
    .onConflictDoUpdate({
      target: [dmConversations.owner, dmConversations.dmId],
      // The caller verified `counterparty` derives `dmId` with the owner, so on
      // a consistent row this is the same actor (§7.4: the counterparty is fixed
      // by the dmId) — it only replaces an inconsistent, ignored row's value.
      set: {
        counterparty: canonicalCounterparty,
        updatedAt: now,
        // The preview's store time moves only with the preview itself: a PUT
        // without `lastMessage` changes no preview, so it can't reorder one.
        // Re-sending the SAME message (by `id`, e.g. a retried or replayed PUT)
        // keeps the original store time, so an old message can't be re-stamped
        // to beat a newer received reply.
        ...(lastSent !== undefined && cached !== null
          ? {
              lastSentMessage: cached,
              lastSentAt: sql`CASE WHEN json_valid(${dmConversations.lastSentMessage}) THEN CASE WHEN json_extract(${dmConversations.lastSentMessage}, '$.id') = ${lastSent.id} THEN ${dmConversations.lastSentAt} ELSE ${now} END ELSE ${now} END`,
            }
          : {}),
      },
    })
    .run();
  return true;
}

/** The newest inbox row for (owner, dmId), or undefined for an empty inbox. */
function lastInboxRow(db: Db, owner: string, dmId: string): DmMessageRow | undefined {
  return db.drizzle
    .select()
    .from(dmMessages)
    .where(and(eq(dmMessages.owner, owner), eq(dmMessages.dmId, dmId)))
    .orderBy(sql`${dmMessages.seq} DESC`)
    .limit(1)
    .all()[0];
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
