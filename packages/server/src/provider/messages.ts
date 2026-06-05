/**
 * Message storage + canonical-shape mapping (spec §5.3, §7.2).
 *
 * Owns the persistence helpers the messages history endpoint builds on, keeping
 * the HTTP layer thin: row ↔ canonical `Message` translation, message creation
 * (seq/edit-window stamping), single-message lookup, and the keyset-paginated
 * channel timeline read (§7.2). Authorization (channel visibility / posting
 * rights) is the caller's responsibility — this module owns the `messages` row
 * lifecycle only.
 *
 * ## The seq / cursor contract (reused by the WS create/edit/delete/resume cards)
 * Every message carries a globally-monotonic integer `seq`, assigned
 * `MAX(seq)+1` inside the insert transaction. `seq` is the **absolute timeline
 * position**: messages within a channel are totally ordered by `seq` (and, since
 * `seq` is globally unique, never collide across channels). The §7.2 opaque
 * REST cursor and the §7.1 WS resume `since` cursor are **the same value** — an
 * opaque encoding of a `seq`. Concretely:
 *
 *  - the cursor encodes `{ seq }` via the shared {@link encodeCursor} codec
 *    (base64url JSON), so it is opaque to clients but a stable keyset to us;
 *  - `direction: "backward"` (default) walks newest→oldest (`seq DESC`),
 *    `direction: "forward"` walks oldest→newest (`seq ASC`);
 *  - a cursor is **exclusive**: paging returns rows strictly past it in the
 *    travel direction, so following `nextCursor` never repeats or skips a row;
 *  - `nextCursor` continues in the requested direction; `prevCursor` is the
 *    cursor to walk back the other way from the first item of the page.
 *
 * The WS resume card replays timeline events strictly after a `since` cursor by
 * decoding it to a `seq` and selecting `seq > since` — the same keyset, so live
 * events and REST history interleave without gaps (§7.1). Tombstoned messages
 * (`deleted_at` set, §7.1) keep their `seq` and are still returned by history,
 * so reply references and resume cursors stay valid; the read query never
 * filters them out (delete itself is a later card).
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
import { and, eq, sql } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { type MessageRow, messages } from "../db/schema.ts";
import { decodeCursor, encodeCursor } from "./membership.ts";

/** `id` prefix per the §5.3 wire examples (`msg_…`). */
const MESSAGE_ID_PREFIX = "msg_";
/** Random bytes of entropy for a message id (16 = 128 bits). */
const MESSAGE_ID_BYTES = 16;

/** Default + max page size for the history listing (§7.2). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Direction of travel over the timeline (§7.2). */
export type PageDirection = "backward" | "forward";

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
// Cursor (§7.2) — opaque encoding of a `seq` keyset position.
// ---------------------------------------------------------------------------

/** Keyset position for the message timeline: a single `seq`. */
interface MessageCursor {
  readonly seq: number;
}

/** Encode a `seq` as the §7.2 opaque cursor (shared with §7.1 resume). */
export function encodeMessageCursor(seq: number): string {
  return encodeCursor({ seq } satisfies MessageCursor);
}

/**
 * Decode a §7.2 opaque cursor back to its `seq`, or `null` if it is malformed
 * (a forged/garbage cursor is treated as "no cursor" — first page).
 */
export function decodeMessageCursor(cursor: string): number | null {
  const pos = decodeCursor<MessageCursor>(cursor);
  return pos && typeof pos.seq === "number" ? pos.seq : null;
}

// ---------------------------------------------------------------------------
// Mapping + queries
// ---------------------------------------------------------------------------

/**
 * Map a stored row to the canonical, schema-valid `Message` (§5.3), including
 * `permissions.editUntil`. A tombstoned row (`deleted_at` set) keeps its id and
 * carries `deletedAt`; callers may still surface it as a tombstone (§7.1).
 */
export function rowToMessage(row: MessageRow): Message {
  const content = JSON.parse(row.content) as Content;
  const attachments = JSON.parse(row.attachments) as Attachment[];
  const tags = JSON.parse(row.tags) as string[];
  const reference = row.reference ? (JSON.parse(row.reference) as MessageReference) : undefined;
  return MessageSchema.parse({
    id: row.id,
    author: row.author,
    type: row.type,
    content,
    attachments,
    ...(reference ? { reference } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    ...(row.editedAt != null ? { editedAt: rfc3339Timestamp(new Date(row.editedAt)) } : {}),
    ...(row.deletedAt != null ? { deletedAt: rfc3339Timestamp(new Date(row.deletedAt)) } : {}),
    permissions: { editUntil: rfc3339Timestamp(new Date(row.editUntil)) },
    // Messages carry no first-class metadata field on the wire model yet; an
    // empty list keeps the canonical shape valid + forward-compatible.
    metadata: [] as MetadataList,
  });
}

/** The raw stored row for `messageId` in `channelId`, or `null` if none. */
export function getMessageRow(db: Db, channelId: string, messageId: string): MessageRow | null {
  return (
    db.drizzle
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.id, messageId)))
      .limit(1)
      .all()[0] ?? null
  );
}

/** The canonical `Message` for `messageId` in `channelId`, or `null` if none. */
export function getMessage(db: Db, channelId: string, messageId: string): Message | null {
  const row = getMessageRow(db, channelId, messageId);
  return row ? rowToMessage(row) : null;
}

/**
 * Look up an existing message by its WS-create idempotency key (§7.1):
 * `(author, channelId, clientMessageId)`. Returns the stored {@link MessageRecord}
 * (canonical message + `seq` + opaque cursor) for the prior create, or `null` if
 * no such message exists. Backed by the partial unique index, so it matches the
 * (at most one) row a duplicate `message.create` would otherwise have inserted.
 */
export function getMessageByClientId(
  db: Db,
  author: string,
  channelId: string,
  clientMessageId: string,
): MessageRecord | null {
  const row =
    db.drizzle
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.author, author),
          eq(messages.channelId, channelId),
          eq(messages.clientMessageId, clientMessageId),
        ),
      )
      .limit(1)
      .all()[0] ?? null;
  if (!row) return null;
  return { message: rowToMessage(row), seq: row.seq, cursor: encodeMessageCursor(row.seq) };
}

/** Arguments to {@link createMessage}. */
export interface CreateMessageInput {
  readonly channelId: string;
  readonly groupId: string;
  /** Author actor (`handle@domain`). */
  readonly author: string;
  /** `message` | `memo` | `article`. */
  readonly type: Message["type"];
  readonly content: Content;
  readonly attachments?: Attachment[];
  readonly reference?: MessageReference;
  readonly tags?: string[];
  /**
   * WS-create idempotency key (§7.1). Stored on a nullable column for the WS
   * create card to enforce `(author, channelId, clientMessageId)` uniqueness;
   * unused by the REST read path.
   */
  readonly clientMessageId?: string;
}

/** The stored record returned by {@link createMessage}: canonical + raw seq. */
export interface MessageRecord {
  /** The canonical, schema-valid `Message`. */
  readonly message: Message;
  /** This message's timeline position; basis of its opaque cursor (§7.2). */
  readonly seq: number;
  /** The opaque history/resume cursor pointing at this message. */
  readonly cursor: string;
}

/**
 * Insert a new message into `channelId`, assigning its `id`, `created_at`,
 * monotonic `seq` (= `MAX(seq)+1`), and `edit_until` (= `created_at +
 * messageEditWindowSeconds`, surfaced as `permissions.editUntil`). The seq read
 * + insert run in one transaction so concurrent creates get distinct, gap-free
 * positions. Returns the canonical `Message` plus its `seq` and opaque cursor.
 * Authorization (channel visibility + `post`) is the caller's responsibility.
 */
export function createMessage(db: Db, config: Config, input: CreateMessageInput): MessageRecord {
  const now = Date.now();
  const editUntil = now + config.messageEditWindowSeconds * 1000;
  const id = mintMessageId();

  let row!: MessageRow;
  db.sqlite.transaction(() => {
    const maxRow = db.drizzle
      .select({ max: sql<number | null>`MAX(${messages.seq})` })
      .from(messages)
      .all()[0];
    const seq = (maxRow?.max ?? 0) + 1;
    row = {
      id,
      channelId: input.channelId,
      groupId: input.groupId,
      author: input.author,
      type: input.type,
      content: JSON.stringify(input.content),
      attachments: JSON.stringify(input.attachments ?? []),
      reference: input.reference ? JSON.stringify(input.reference) : null,
      tags: JSON.stringify(input.tags ?? []),
      seq,
      createdAt: now,
      editedAt: null,
      deletedAt: null,
      editUntil,
      clientMessageId: input.clientMessageId ?? null,
    };
    db.drizzle.insert(messages).values(row).run();
  })();

  return { message: rowToMessage(row), seq: row.seq, cursor: encodeMessageCursor(row.seq) };
}

/**
 * The cleared content a tombstone carries. A tombstoned message (§7.1) keeps its
 * `id`/`seq` but its body is wiped; the canonical `Message` still REQUIRES a
 * `content`, so we store a minimal, schema-valid empty body. `deletedAt` (set by
 * {@link tombstoneMessage}) is the real "this is deleted" signal clients render.
 */
const TOMBSTONE_CONTENT: Content = { text: "", mime: "text/plain" };

/**
 * Replace a message's `content` and stamp `edited_at = now` (§7.1 edit). The
 * caller is responsible for authorization (author-only) and the edit-window check
 * (`permissions.editUntil` in the future) BEFORE calling this. Returns the
 * updated canonical {@link MessageRecord} (message + seq + cursor). Throws if the
 * row does not exist (callers check existence first).
 */
export function updateMessageContent(
  db: Db,
  channelId: string,
  messageId: string,
  content: Content,
): MessageRecord {
  const now = Date.now();
  db.drizzle
    .update(messages)
    .set({ content: JSON.stringify(content), editedAt: now })
    .where(and(eq(messages.channelId, channelId), eq(messages.id, messageId)))
    .run();
  const row = getMessageRow(db, channelId, messageId);
  if (!row) throw new Error(`updateMessageContent: no such message ${messageId}`);
  return { message: rowToMessage(row), seq: row.seq, cursor: encodeMessageCursor(row.seq) };
}

/**
 * Soft-delete (tombstone) a message (§7.1): keep its `id` and `seq` so reply
 * references and resume cursors stay valid, clear `content`, and stamp
 * `deleted_at = now`. The row is NOT removed and still appears in history as a
 * tombstone. The caller is responsible for authorization (author or `moderate`)
 * BEFORE calling. Returns the tombstoned canonical {@link MessageRecord}. Throws
 * if the row does not exist (callers check existence first).
 */
export function tombstoneMessage(db: Db, channelId: string, messageId: string): MessageRecord {
  const now = Date.now();
  db.drizzle
    .update(messages)
    .set({ content: JSON.stringify(TOMBSTONE_CONTENT), deletedAt: now })
    .where(and(eq(messages.channelId, channelId), eq(messages.id, messageId)))
    .run();
  const row = getMessageRow(db, channelId, messageId);
  if (!row) throw new Error(`tombstoneMessage: no such message ${messageId}`);
  return { message: rowToMessage(row), seq: row.seq, cursor: encodeMessageCursor(row.seq) };
}

/**
 * Outcome of a WS resume request (§7.1 "Resuming after a disconnect") for one
 * channel + `since` cursor: either the post-cursor messages to replay or a
 * truncation signal telling the caller to fall back to REST history (§7.2).
 */
export type ResumeOutcome =
  | {
      /** The gap is replayable: messages with `seq > sinceSeq`, ascending. */
      readonly truncated: false;
      readonly messages: MessageRecord[];
    }
  | {
      /** The gap exceeds the cap (or predates retention) — backfill via REST. */
      readonly truncated: true;
      readonly messages?: undefined;
    };

/**
 * Resolve the channel timeline events to replay strictly after `sinceSeq`
 * (§7.1). Returns the post-cursor messages in **ascending** `seq` order, each in
 * its CURRENT canonical state (so edits/deletes since the cursor are reflected),
 * as {@link MessageRecord}s carrying the per-message resume cursor.
 *
 * Truncation (caller falls back to REST history, §7.2) when either:
 *  - the number of post-cursor messages exceeds `cap`; or
 *  - `sinceSeq` predates the channel's oldest RETAINED message — i.e. the oldest
 *    row has `seq > sinceSeq + 1`, so messages between the cursor and the oldest
 *    retained row may have been reaped and replay could leave a gap.
 *
 * Tombstoned messages keep their `seq` and are replayed as tombstones (§7.1), so
 * a delete after the cursor is reflected in the replayed copy.
 */
export function resumeMessages(
  db: Db,
  channelId: string,
  sinceSeq: number,
  cap: number,
): ResumeOutcome {
  // Oldest retained row in the channel; if it sits strictly past `sinceSeq + 1`
  // the cursor predates retention (older messages may have been reaped) → can't
  // guarantee a gap-free replay.
  const minRow = db.drizzle
    .select({ min: sql<number | null>`MIN(${messages.seq})` })
    .from(messages)
    .where(eq(messages.channelId, channelId))
    .all()[0];
  const minSeq = minRow?.min ?? null;
  if (minSeq != null && minSeq > sinceSeq + 1) {
    return { truncated: true };
  }

  // Fetch one extra past the cap to detect "gap too large" without loading the
  // whole tail.
  const rows = db.drizzle
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channelId), sql`${messages.seq} > ${sinceSeq}`))
    .orderBy(sql`${messages.seq} ASC`)
    .limit(cap + 1)
    .all();

  if (rows.length > cap) {
    return { truncated: true };
  }

  const replay = rows.map(
    (row): MessageRecord => ({
      message: rowToMessage(row),
      seq: row.seq,
      cursor: encodeMessageCursor(row.seq),
    }),
  );
  return { truncated: false, messages: replay };
}

/** Options for {@link listMessages}. */
export interface ListMessagesOptions {
  /** Opaque cursor to page from (exclusive); omit for the first page. */
  readonly cursor?: string | null;
  /** `backward` (default, newest-first) or `forward` (oldest-first). */
  readonly direction?: PageDirection;
  /** Page size; clamped to {@link MAX_PAGE_SIZE}, default {@link DEFAULT_PAGE_SIZE}. */
  readonly limit?: number;
}

/** A page of timeline items plus the §7.2 cursor pair. */
export interface MessagePage {
  readonly items: Message[];
  readonly page: {
    /** Opaque cursor to continue in `direction`, or `undefined` at the end. */
    readonly nextCursor?: string;
    /** Opaque cursor to walk back the other way, or `undefined` at the edge. */
    readonly prevCursor?: string;
  };
}

/**
 * Read one page of `channelId`'s timeline by keyset over `seq` (§7.2).
 *
 *  - `direction: "backward"` (default) returns the newest messages first
 *    (`seq DESC`); `"forward"` returns oldest first (`seq ASC`).
 *  - `cursor` is **exclusive**: rows strictly past it in the travel direction
 *    are returned, so following `nextCursor` never repeats or skips. A malformed
 *    cursor is treated as the first page.
 *  - `nextCursor` is present only when a further page exists in `direction`.
 *  - `prevCursor` points just past the **first** item of this page in the
 *    opposite direction, so a client can walk back; it is `undefined` only for
 *    an empty page.
 *
 * Tombstoned messages (§7.1) are not filtered out — they keep their `seq` and
 * are returned so references/resume cursors stay valid.
 */
export function listMessages(
  db: Db,
  channelId: string,
  opts: ListMessagesOptions = {},
): MessagePage {
  const direction: PageDirection = opts.direction === "forward" ? "forward" : "backward";
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const after = opts.cursor ? decodeMessageCursor(opts.cursor) : null;

  // Keyset predicate: rows strictly past `after` in the travel direction.
  // backward → seq < after (descending), forward → seq > after (ascending).
  const channelEq = eq(messages.channelId, channelId);
  const where =
    after != null
      ? and(
          channelEq,
          direction === "forward"
            ? sql`${messages.seq} > ${after}`
            : sql`${messages.seq} < ${after}`,
        )
      : channelEq;

  // Fetch one extra row to detect a further page.
  const rows = db.drizzle
    .select()
    .from(messages)
    .where(where)
    .orderBy(direction === "forward" ? sql`${messages.seq} ASC` : sql`${messages.seq} DESC`)
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(rowToMessage);

  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];

  // nextCursor continues in `direction` past the last item (only if more exist).
  const nextCursor = hasMore && last ? encodeMessageCursor(last.seq) : undefined;
  // prevCursor walks the other way from the first item of this page.
  const prevCursor = first ? encodeMessageCursor(first.seq) : undefined;

  return {
    items,
    page: {
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(prevCursor !== undefined ? { prevCursor } : {}),
    },
  };
}
