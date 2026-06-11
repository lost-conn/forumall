/**
 * Read-marker storage + unread-summary computation (read/unread tracking — a
 * provider-local extension, mirroring the per-user `privacy_settings` / `presence`
 * pattern). Owns the `read_markers` row lifecycle and the unread aggregation,
 * keeping the HTTP layer thin.
 *
 * ## Unified scope + monotonic markers
 * A `scopeId` is a channel id (`chn_…`) or a DM conversation id (`dmId`, §7.4).
 * One table is correct because the global monotonic `seq` space already spans
 * both channel `messages` and `dm_messages`, so a single `last_read_seq` compares
 * against either store. Markers are **monotonic**: {@link setReadMarkers} never
 * moves one backward (it takes `MAX(existing, incoming)`).
 *
 * ## Unread counts
 * For a channel scope, unread = messages with `seq > last_read_seq` the user did
 * NOT author, over channels the user can currently see. For a DM scope, unread =
 * `dm_messages` in the user's inbox with `seq > last_read_seq` the user did NOT
 * author. With no marker, everything is unread (last_read_seq treated as 0). The
 * user's own messages are excluded so sending a message never bumps your own
 * unread count.
 *
 * Read state is private + per-account and is NEVER federated: markers key on the
 * LOCAL `handle`, and only locally-hosted channels + local DM inboxes are
 * summarized (remote channel read-state is out of scope).
 */
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import {
  type ReadMarkerRow,
  channels,
  dmConversations,
  dmMessages,
  groupMembers,
  messages,
  readMarkers,
} from "../db/schema.ts";
import { canViewChannel } from "./channels.ts";

/** A stored read marker (no unread count). */
export interface ReadMarkerEntry {
  readonly scopeId: string;
  readonly lastReadSeq: number;
}

/** A summary entry: a marker plus the recomputed unread count for its scope. */
export interface UnreadEntry {
  readonly scopeId: string;
  readonly lastReadSeq: number;
  readonly unreadCount: number;
}

/** All read markers for `handle`, as a `scopeId → lastReadSeq` map. */
export function getReadMarkers(db: Db, handle: string): Map<string, number> {
  const rows = db.drizzle.select().from(readMarkers).where(eq(readMarkers.handle, handle)).all();
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.scopeId, r.lastReadSeq);
  return map;
}

/** The raw marker row for (handle, scopeId), or `null` if unset. */
export function getReadMarkerRow(db: Db, handle: string, scopeId: string): ReadMarkerRow | null {
  return (
    db.drizzle
      .select()
      .from(readMarkers)
      .where(and(eq(readMarkers.handle, handle), eq(readMarkers.scopeId, scopeId)))
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Upsert one or many markers for `handle`, MONOTONICALLY: a marker is only moved
 * forward — an incoming `lastReadSeq` at or below the stored value is ignored (no
 * backward move). Returns the set of `scopeId`s that were actually advanced (so
 * the caller can recompute + fan out only those). Runs in one transaction.
 */
export function setReadMarkers(
  db: Db,
  handle: string,
  entries: readonly ReadMarkerEntry[],
): Set<string> {
  const advanced = new Set<string>();
  if (entries.length === 0) return advanced;
  const now = Date.now();
  db.sqlite.transaction(() => {
    for (const e of entries) {
      const existing = getReadMarkerRow(db, handle, e.scopeId);
      // Monotonic: never move a marker backward.
      if (existing && existing.lastReadSeq >= e.lastReadSeq) continue;
      db.drizzle
        .insert(readMarkers)
        .values({
          handle,
          scopeId: e.scopeId,
          lastReadSeq: e.lastReadSeq,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [readMarkers.handle, readMarkers.scopeId],
          set: { lastReadSeq: e.lastReadSeq, updatedAt: now },
        })
        .run();
      advanced.add(e.scopeId);
    }
  })();
  return advanced;
}

/**
 * Unread message count in a CHANNEL scope for `handle`: channel messages with
 * `seq > sinceSeq` not authored by `actor`. Tombstoned messages still keep a
 * `seq` and are counted (they remain visible as tombstones in history).
 */
function channelUnread(db: Db, channelId: string, sinceSeq: number, actor: string): number {
  const row = db.drizzle
    .select({ n: sql<number>`COUNT(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        sql`${messages.seq} > ${sinceSeq}`,
        sql`${messages.author} <> ${actor}`,
      ),
    )
    .all()[0];
  return Number(row?.n ?? 0);
}

/**
 * Unread message count in a DM scope for `handle`'s inbox: `dm_messages` with
 * `owner = handle`, `dm_id = dmId`, `seq > sinceSeq`, not authored by `actor`.
 */
function dmUnread(db: Db, handle: string, dmId: string, sinceSeq: number, actor: string): number {
  const row = db.drizzle
    .select({ n: sql<number>`COUNT(*)` })
    .from(dmMessages)
    .where(
      and(
        eq(dmMessages.owner, handle),
        eq(dmMessages.dmId, dmId),
        sql`${dmMessages.seq} > ${sinceSeq}`,
        sql`${dmMessages.author} <> ${actor}`,
      ),
    )
    .all()[0];
  return Number(row?.n ?? 0);
}

/**
 * The full unread summary for `handle` (`actor` = `handle@<thisDomain>`): one
 * entry per scope the user can currently SEE — every visible channel of every
 * group the user belongs to, plus every DM conversation in the user's inbox. The
 * user's own messages are excluded from every count.
 *
 * Visible channels are resolved via {@link canViewChannel} (tier + membership +
 * per-channel `view` override), so a member who cannot read a restricted channel
 * does not get a phantom unread badge for it.
 */
export function getUnreadSummary(db: Db, handle: string, actor: string): UnreadEntry[] {
  const markers = getReadMarkers(db, handle);
  const out: UnreadEntry[] = [];

  // --- Channels: enumerate the user's group memberships → visible channels. ---
  const memberGroupRows = db.drizzle
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.user, actor))
    .all();
  const groupIds = new Set(memberGroupRows.map((r) => r.groupId));
  if (groupIds.size > 0) {
    // One pass over the user's groups' channels; visibility-filtered.
    const channelRows = db.drizzle.select().from(channels).all();
    for (const ch of channelRows) {
      if (!groupIds.has(ch.groupId)) continue;
      if (!canViewChannel(db, ch, actor)) continue;
      const sinceSeq = markers.get(ch.id) ?? 0;
      const unreadCount = channelUnread(db, ch.id, sinceSeq, actor);
      out.push({ scopeId: ch.id, lastReadSeq: sinceSeq, unreadCount });
    }
  }

  // --- DMs: enumerate the user's inbox conversations. ---
  const convRows = db.drizzle
    .select({ dmId: dmConversations.dmId })
    .from(dmConversations)
    .where(eq(dmConversations.owner, handle))
    .all();
  for (const conv of convRows) {
    const sinceSeq = markers.get(conv.dmId) ?? 0;
    const unreadCount = dmUnread(db, handle, conv.dmId, sinceSeq, actor);
    out.push({ scopeId: conv.dmId, lastReadSeq: sinceSeq, unreadCount });
  }

  return out;
}

/**
 * Recompute the {@link UnreadEntry} for a single scope (channel or DM) after a
 * marker advance, for the `read.updated` fan-out. The scope kind is inferred from
 * the id prefix (`chn_` → channel; otherwise a DM `dmId`).
 */
export function unreadEntryFor(
  db: Db,
  handle: string,
  actor: string,
  scopeId: string,
  lastReadSeq: number,
): UnreadEntry {
  const unreadCount = scopeId.startsWith("chn_")
    ? channelUnread(db, scopeId, lastReadSeq, actor)
    : dmUnread(db, handle, scopeId, lastReadSeq, actor);
  return { scopeId, lastReadSeq, unreadCount };
}
