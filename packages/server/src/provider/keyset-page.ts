/**
 * Keyset pager over a `(timestamp, id)` total order (spec §7.2), for listings
 * ordered by a creation time with ties broken by id: the invite listing
 * (`createdAt`, §5.6) and the pending join-request listing (`requestedAt`,
 * §5.7).
 *
 * The caller owns its query: {@link keysetQuery} gives the keyset predicate,
 * the `ORDER BY` and the row limit (one extra row, to detect a further page),
 * and {@link keysetPage} turns the fetched rows into the page's rows plus the
 * §7.2 cursor pair. Semantics match the message pager (`messages.ts`):
 *
 *  - `backward` (the default) lists newest first (`ts DESC, id DESC`),
 *    `forward` oldest first (`ts ASC, id ASC`);
 *  - a cursor is exclusive: only rows strictly past it in the direction of
 *    travel are returned;
 *  - `nextCursor` is present only when a further page exists in `direction`;
 *    `prevCursor` marks the page's first item, for walking the other way with
 *    the opposite `direction`;
 *  - `limit` defaults to {@link DEFAULT_PAGE_SIZE}, is clamped to
 *    {@link MAX_PAGE_SIZE} and rounded down; a malformed cursor reads as none.
 */
import { type SQL, and, eq, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type PageDirection } from "./messages.ts";

/** Paging request for a keyset listing (parsed §7.2 query params). */
export interface KeysetPageOptions {
  /** Opaque cursor to page from (exclusive); `null`/absent for the first page. */
  readonly cursor?: string | null;
  /** `backward` (default, newest first) or `forward` (oldest first). */
  readonly direction?: PageDirection;
  /** Requested page size; defaulted and clamped per §7.2. */
  readonly limit?: number;
}

/** A row's position in the `(timestamp, id)` order — the cursor payload. */
export interface KeysetPosition {
  /** Timestamp (epoch millis). */
  readonly t: number;
  /** Row id, the tie-breaker. */
  readonly id: string;
}

/** The query pieces for one keyset page. */
export interface KeysetQuery {
  /** Keyset predicate to AND onto the listing's scope, or `undefined`. */
  readonly where: SQL | undefined;
  /** `ORDER BY` terms in the direction of travel. */
  readonly orderBy: SQL[];
  /** Rows to fetch: the page size plus one (to detect a further page). */
  readonly fetch: number;
  /** The resolved page size. */
  readonly limit: number;
}

/** The §7.2 cursor pair for a page. */
export interface KeysetPageInfo {
  readonly nextCursor?: string;
  readonly prevCursor?: string;
}

/** Resolve a requested page size per §7.2: default 50, max 100, rounded down. */
export function resolvePageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

/** Decode a keyset cursor, or `null` when it is malformed or of another shape. */
function decodeKeysetCursor(cursor: string): KeysetPosition | null {
  const raw = decodeCursor<unknown>(cursor);
  if (raw === null || typeof raw !== "object") return null;
  const { t, id } = raw as { t?: unknown; id?: unknown };
  if (typeof t !== "number" || !Number.isFinite(t) || typeof id !== "string") return null;
  return { t, id };
}

/** Encode a row position as an opaque keyset cursor. */
function encodeKeysetCursor(position: KeysetPosition): string {
  return encodeCursor({ t: position.t, id: position.id });
}

/** Build the keyset predicate, ordering and fetch size over `(tsCol, idCol)`. */
export function keysetQuery(
  tsCol: SQLiteColumn,
  idCol: SQLiteColumn,
  opts: KeysetPageOptions,
): KeysetQuery {
  const forward = opts.direction === "forward";
  const limit = resolvePageLimit(opts.limit);
  const after = opts.cursor ? decodeKeysetCursor(opts.cursor) : null;

  // Rows strictly past `after` in the travel direction:
  // forward  → ts > t OR (ts = t AND id > i);
  // backward → ts < t OR (ts = t AND id < i).
  const where = after
    ? forward
      ? or(sql`${tsCol} > ${after.t}`, and(eq(tsCol, after.t), sql`${idCol} > ${after.id}`))
      : or(sql`${tsCol} < ${after.t}`, and(eq(tsCol, after.t), sql`${idCol} < ${after.id}`))
    : undefined;
  const orderBy = forward
    ? [sql`${tsCol} ASC`, sql`${idCol} ASC`]
    : [sql`${tsCol} DESC`, sql`${idCol} DESC`];

  return { where, orderBy, fetch: limit + 1, limit };
}

/**
 * Split fetched rows (at most `query.fetch`) into the page's rows and its §7.2
 * cursor pair. `positionOf` reads a row's `(timestamp, id)`.
 */
export function keysetPage<R>(
  rows: readonly R[],
  query: KeysetQuery,
  positionOf: (row: R) => KeysetPosition,
): { rows: R[]; page: KeysetPageInfo } {
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows.slice();
  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeKeysetCursor(positionOf(last)) : undefined;
  const prevCursor = first ? encodeKeysetCursor(positionOf(first)) : undefined;
  return {
    rows: pageRows,
    page: {
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(prevCursor !== undefined ? { prevCursor } : {}),
    },
  };
}
