/**
 * Reaction storage + canonical-shape mapping (spec §5.3, §7.1 "Reactions").
 *
 * Owns the persistence helpers the reactions WS commands + REST endpoints build
 * on, keeping the transport layers thin: row ↔ canonical `Reaction` translation,
 * the idempotent add, the remove, and the keyset-paginated per-message listing
 * (§7.1 history / late-joiners). Authorization (channel visibility, message
 * existence) is the caller's responsibility — this module owns the `reactions`
 * row lifecycle only.
 *
 * ## The one-per-(message, author, key) rule (§5.3)
 * A user may hold at most ONE reaction per `key` per message. {@link addReaction}
 * is idempotent against the unique `(message_id, author, key)` index: a repeat
 * add returns the EXISTING reaction (same `id`) rather than inserting a
 * duplicate. OFSCP v0.1 stores no server-aggregated count — two different users
 * adding the same key yield two rows, and clients aggregate the total from the
 * reaction objects / `reaction.added`/`reaction.removed` events.
 *
 * ## Pagination
 * {@link listReactions} pages over the keyset `(created_at, id)` — a stable total
 * order (the unique `id` breaks `created_at` ties) — using the shared opaque
 * cursor codec ({@link encodeCursor}/{@link decodeCursor}), exactly like the
 * member/message listings. The canonical `Reaction.reference` is always
 * `{ type: "message", id: <messageId> }`, re-derived here from the stored
 * `message_id`.
 */
import { type Reaction, ReactionSchema, rfc3339Timestamp } from "@forumall/shared";
import { and, eq, or, sql } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type ReactionRow, reactions } from "../db/schema.ts";
import { decodeCursor, encodeCursor } from "./membership.ts";

/** `id` prefix per the §5.3 wire examples (`rct_…`). */
const REACTION_ID_PREFIX = "rct_";
/** Random bytes of entropy for a reaction id (16 = 128 bits). */
const REACTION_ID_BYTES = 16;

/** Default + max page size for the reactions listing (§7.1, mirrors §7.2). */
export const DEFAULT_REACTION_PAGE_SIZE = 50;
export const MAX_REACTION_PAGE_SIZE = 100;

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

/**
 * Map a stored row to the canonical, schema-valid `Reaction` (§5.3). The
 * `reference` is always `{ type: "message", id: <messageId> }`; `unicode`/`image`
 * are surfaced only when set. Messages/reactions carry no first-class metadata
 * field yet, so an empty list keeps the shape valid + forward-compatible.
 */
export function rowToReaction(row: ReactionRow): Reaction {
  return ReactionSchema.parse({
    id: row.id,
    author: row.author,
    key: row.key,
    ...(row.unicode != null ? { unicode: row.unicode } : {}),
    ...(row.image != null ? { image: row.image } : {}),
    reference: { type: "message", id: row.messageId },
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    metadata: [],
  });
}

/** The raw row for (message, author, key), or `null` if the user hasn't reacted. */
function getReactionRow(
  db: Db,
  messageId: string,
  author: string,
  key: string,
): ReactionRow | null {
  return (
    db.drizzle
      .select()
      .from(reactions)
      .where(
        and(
          eq(reactions.messageId, messageId),
          eq(reactions.author, author),
          eq(reactions.key, key),
        ),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Whether `author` already holds reaction `key` on `messageId`. Used by the REST
 * `PUT` to choose 200 (idempotent repeat) vs 201 (first add) before calling
 * {@link addReaction}.
 */
export function hasReaction(db: Db, messageId: string, author: string, key: string): boolean {
  return getReactionRow(db, messageId, author, key) !== null;
}

/** Arguments to {@link addReaction}. */
export interface AddReactionInput {
  readonly messageId: string;
  readonly channelId: string;
  readonly groupId: string;
  /** Reacting actor (`handle@domain`). */
  readonly author: string;
  readonly key: string;
  readonly unicode?: string;
  readonly image?: string;
}

/**
 * Add `author`'s reaction `key` to a message, idempotently (§5.3). If the user
 * already holds that key on the message, the EXISTING reaction is returned
 * unchanged (same `id`, no duplicate row); otherwise a new row is inserted.
 * Returns the canonical `Reaction`. Authorization (channel visibility, message
 * existence) is the caller's responsibility.
 */
export function addReaction(db: Db, input: AddReactionInput): Reaction {
  const existing = getReactionRow(db, input.messageId, input.author, input.key);
  if (existing) return rowToReaction(existing);

  const row: ReactionRow = {
    id: mintReactionId(),
    messageId: input.messageId,
    channelId: input.channelId,
    groupId: input.groupId,
    author: input.author,
    key: input.key,
    unicode: input.unicode ?? null,
    image: input.image ?? null,
    createdAt: Date.now(),
  };
  try {
    db.drizzle.insert(reactions).values(row).run();
  } catch (err) {
    // Idempotency race: a concurrent add won the unique (message, author, key)
    // index. Fall back to the row it inserted and return that.
    if (isUniqueViolation(err)) {
      const winner = getReactionRow(db, input.messageId, input.author, input.key);
      if (winner) return rowToReaction(winner);
    }
    throw err;
  }
  return rowToReaction(row);
}

/**
 * Remove `author`'s reaction `key` from a message. Returns `true` if a reaction
 * was removed, `false` if none existed (idempotent remove). Authorization is the
 * caller's responsibility.
 */
export function removeReaction(db: Db, messageId: string, author: string, key: string): boolean {
  const existing = getReactionRow(db, messageId, author, key);
  if (!existing) return false;
  db.drizzle
    .delete(reactions)
    .where(
      and(eq(reactions.messageId, messageId), eq(reactions.author, author), eq(reactions.key, key)),
    )
    .run();
  return true;
}

/** Keyset position for the reactions listing: `(createdAt, id)` — a total order. */
interface ReactionCursor {
  readonly createdAt: number;
  readonly id: string;
}

/** Options for {@link listReactions}. */
export interface ListReactionsOptions {
  /** Opaque cursor to page from (exclusive); omit for the first page. */
  readonly cursor?: string | null;
  /** Page size; clamped to {@link MAX_REACTION_PAGE_SIZE}, default 50. */
  readonly limit?: number;
}

/** A page of reactions plus the §7.1 next-cursor. */
export interface ReactionPage {
  readonly items: Reaction[];
  readonly page: {
    /** Opaque cursor for the next page, or `undefined` when this is the last. */
    readonly nextCursor?: string;
  };
}

/**
 * List a message's reactions ordered by `(created_at, id)`, one page at a time
 * (§7.1 history / late-joiners). `limit` items are returned; if more exist,
 * `nextCursor` is the opaque cursor for the page after the last returned item. A
 * malformed `cursor` is treated as the first page.
 */
export function listReactions(
  db: Db,
  messageId: string,
  opts: ListReactionsOptions = {},
): ReactionPage {
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_REACTION_PAGE_SIZE)
      : DEFAULT_REACTION_PAGE_SIZE;
  const after = opts.cursor ? decodeCursor<ReactionCursor>(opts.cursor) : null;

  // Keyset predicate: rows strictly after (createdAt, id) in the total order.
  // (createdAt > a) OR (createdAt = a AND id > i).
  const messageEq = eq(reactions.messageId, messageId);
  const where =
    after && typeof after.createdAt === "number" && typeof after.id === "string"
      ? and(
          messageEq,
          or(
            sql`${reactions.createdAt} > ${after.createdAt}`,
            and(eq(reactions.createdAt, after.createdAt), sql`${reactions.id} > ${after.id}`),
          ),
        )
      : messageEq;

  // Fetch one extra row to detect whether a further page exists.
  const rows = db.drizzle
    .select()
    .from(reactions)
    .where(where)
    .orderBy(reactions.createdAt, reactions.id)
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : undefined;

  return {
    items: pageRows.map(rowToReaction),
    page: { ...(nextCursor !== undefined ? { nextCursor } : {}) },
  };
}

/** Whether `err` is a SQLite UNIQUE-constraint violation (idempotency race). */
function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}
