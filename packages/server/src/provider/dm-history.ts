/**
 * Direct-message history (§7.4 reading): one page of a viewer's full
 * conversation view, in the same cursor space + shape as §7.2 channel history.
 */
import type { Message } from "@forumall/shared";
import { and, eq, or, sql } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { dmMessages } from "../db/schema.ts";
import {
  DEFAULT_PAGE_SIZE,
  type DmMessageRecord,
  type DmViewer,
  MAX_PAGE_SIZE,
  rowToDmMessage,
  toDmRecord,
} from "./dms.ts";
import { type PageDirection, encodeMessageCursor } from "./messages.ts";

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

  const scope = viewScope(dmId, viewer);
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

/** The outcome of {@link resumeDmMessages}: a replay set, or "too large". */
export type DmResumeOutcome =
  | { readonly truncated: true }
  | { readonly truncated: false; readonly records: DmMessageRecord[] };

/**
 * The `since` resume of a `dmId` subscription (§7.4 "Real-time": "supports
 * resume with `since`, in the cursor space of its `GET /api/dms/{dmId}/
 * messages`"): every message of `viewer`'s view of `dmId` — exactly the rows
 * {@link listDmMessages} serves them — with `seq > sinceSeq`, ascending, in
 * its CURRENT state (edits and tombstones included). More than `cap` such
 * messages → `truncated`, and the client backfills through REST (§7.1).
 */
export function resumeDmMessages(
  db: Db,
  dmId: string,
  viewer: DmViewer,
  sinceSeq: number,
  cap: number,
): DmResumeOutcome {
  const rows = db.drizzle
    .select()
    .from(dmMessages)
    .where(and(viewScope(dmId, viewer), sql`${dmMessages.seq} > ${sinceSeq}`))
    .orderBy(sql`${dmMessages.seq} ASC`)
    .limit(cap + 1)
    .all();
  if (rows.length > cap) return { truncated: true };
  return { truncated: false, records: rows.map(toDmRecord) };
}

/**
 * The rows of `dmId` that make up `viewer`'s view: the rows they AUTHORED (their
 * sent messages, stored in the counterparty's inbox) OR — when the viewer is
 * local — the rows in their own inbox (their received messages). A self-DM row
 * can satisfy both clauses but is one row under OR, so no duplication.
 */
function viewScope(dmId: string, viewer: DmViewer) {
  return and(
    eq(dmMessages.dmId, dmId),
    viewer.localHandle !== undefined
      ? or(eq(dmMessages.author, viewer.actor), eq(dmMessages.owner, viewer.localHandle))
      : eq(dmMessages.author, viewer.actor),
  );
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
