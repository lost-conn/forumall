/**
 * Discovery feed compilation (spec §11.2, OPTIONAL) — read-time only.
 *
 * The discovery feed is a paged list of **pointers** to `discoverable`-tier
 * channels; the provider MUST NOT store a feed (the real content is always read
 * live from the channel's home provider, §11.2). This module compiles a page of
 * pointers from LOCAL `discoverable`-tier channels at read time, keyset-paged
 * over the channel `rowid` via the shared opaque cursor.
 *
 * ## What is surfaced (tier-respecting)
 * Only channels whose own `tier` is `discoverable` are surfaced (§11.1, §11.2):
 * `private`/`group`/`public` channels are never included. Each item is a pointer
 * `{ channel, groupId?, provider }` and MAY carry a non-authoritative `sample`
 * preview of the channel's most recent (non-tombstoned) message.
 *
 * ## Local-only, with a documented peer-aggregation hook
 * v0.1 compiles from local channels only. §11.2 also permits aggregating
 * `discoverable` channels from this provider's known peers (§8.6) by querying
 * their own `GET /api/discover` — that is an OPTIONAL refinement and is left as a
 * documented hook (see {@link compileDiscoverPage}); nothing about the local
 * compilation or the pointer shape changes when it is added.
 */
import {
  type Content,
  type DiscoverItem,
  type DiscoverResponse,
  DiscoverResponseSchema,
  rfc3339Timestamp,
} from "@forumall/shared";
import { and, eq, sql } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { type ChannelRow, channels, messages } from "../db/schema.ts";
import { decodeCursor, encodeCursor } from "./membership.ts";

/** The tier eligible for the discovery feed (§11.1, §11.2). */
const DISCOVERABLE_TIER = "discoverable";

/** Default + max page size for the discovery feed (mirrors §7.2 paging). */
export const DEFAULT_DISCOVER_PAGE_SIZE = 50;
export const MAX_DISCOVER_PAGE_SIZE = 100;

/** Keyset position for the feed: a channel `rowid` (stable insertion order). */
interface DiscoverCursor {
  readonly rowid: number;
}

/** Encode a channel rowid as the opaque feed cursor. */
function encodeDiscoverCursor(rowid: number): string {
  return encodeCursor({ rowid } satisfies DiscoverCursor);
}

/** Decode a feed cursor back to its rowid, or `null` if malformed (→ first page). */
function decodeDiscoverCursor(cursor: string): number | null {
  const pos = decodeCursor<DiscoverCursor>(cursor);
  return pos && typeof pos.rowid === "number" ? pos.rowid : null;
}

/** Options for {@link compileDiscoverPage}. */
export interface DiscoverPageOptions {
  /** Opaque cursor to page from (exclusive); omit for the first page. */
  readonly cursor?: string | null;
  /** Page size; clamped to {@link MAX_DISCOVER_PAGE_SIZE}. */
  readonly limit?: number;
  /** Include a recent-message `sample` per item (non-authoritative). Default true. */
  readonly withSample?: boolean;
}

/** A discoverable channel row plus its sqlite rowid (the keyset position). */
type ChannelRowWithRowid = ChannelRow & { rowid: number };

/** The most recent non-tombstoned message body in `channelId`, or `null`. */
function recentSample(db: Db, channelId: string): DiscoverItem["sample"] | null {
  const row =
    db.drizzle
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), sql`${messages.deletedAt} IS NULL`))
      .orderBy(sql`${messages.seq} DESC`)
      .limit(1)
      .all()[0] ?? null;
  if (!row) return null;
  const content = JSON.parse(row.content) as Content;
  return {
    id: row.id,
    author: row.author,
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    content,
  };
}

/**
 * Compile one page of the discovery feed (§11.2) from LOCAL `discoverable`-tier
 * channels. Returns the canonical, schema-valid `DiscoverResponse` (validated
 * against `DiscoverResponseSchema`). Nothing is stored — items are pointers
 * compiled here at read time.
 *
 * Pointers are `{ channel: <chn id>, groupId, provider: <this domain> }`, paged
 * by keyset over the channel rowid (oldest-first). `nextCursor` is present only
 * when a further page exists; `prevCursor` points just past the first item.
 *
 * ### Peer-aggregation hook (OPTIONAL, §11.2)
 * To also surface peers' `discoverable` channels, a provider MAY query each
 * known peer's (§8.6) own `GET /api/discover` and merge their items (already
 * carrying the peer's `provider`/`channel`) into this page before validation.
 * That is intentionally NOT done here in v0.1 (local-only); this is the single
 * place that change would live.
 */
export function compileDiscoverPage(
  db: Db,
  config: Config,
  opts: DiscoverPageOptions = {},
): DiscoverResponse {
  const limit =
    opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), MAX_DISCOVER_PAGE_SIZE)
      : DEFAULT_DISCOVER_PAGE_SIZE;
  const withSample = opts.withSample ?? true;
  const after = opts.cursor ? decodeDiscoverCursor(opts.cursor) : null;

  // Keyset over the channel rowid (oldest-first): rows strictly past `after`.
  // `channels` is a STRICT rowid table (its `id` PK is TEXT, not INTEGER), so an
  // explicit `rowid` column exists and is a stable insertion-order keyset.
  const tierEq = eq(channels.tier, DISCOVERABLE_TIER);
  const rowidCol = sql<number>`channels.rowid`;

  const rows = db.drizzle
    .select({
      rowid: rowidCol,
      id: channels.id,
      groupId: channels.groupId,
      name: channels.name,
      type: channels.type,
      tier: channels.tier,
      topic: channels.topic,
      tags: channels.tags,
      metadata: channels.metadata,
      createdAt: channels.createdAt,
      updatedAt: channels.updatedAt,
    })
    .from(channels)
    .where(after != null ? and(tierEq, sql`channels.rowid > ${after}`) : tierEq)
    .orderBy(sql`channels.rowid ASC`)
    .limit(limit + 1)
    .all() as ChannelRowWithRowid[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: DiscoverItem[] = pageRows.map((row) => {
    const sample = withSample ? recentSample(db, row.id) : null;
    return {
      channel: row.id,
      groupId: row.groupId,
      provider: config.domain,
      ...(sample ? { sample } : {}),
    };
  });

  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeDiscoverCursor(last.rowid) : undefined;
  const prevCursor = first ? encodeDiscoverCursor(first.rowid) : undefined;

  return DiscoverResponseSchema.parse({
    items,
    page: {
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(prevCursor !== undefined ? { prevCursor } : {}),
    },
  });
}
