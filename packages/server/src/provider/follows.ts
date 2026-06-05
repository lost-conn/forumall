/**
 * Follows storage + canonical-shape mapping (spec §7.6).
 *
 * A follow is a **pointer**, not a copy: the provider stores only *which*
 * channels a local user follows and MUST NOT compile or store a feed (the client
 * composes the home feed by reading each followed channel from its authoritative
 * source, §7.6). This module owns the `follows` row lifecycle and the
 * row ↔ canonical `Follow` mapping; there is intentionally no feed store.
 *
 * A `Follow` is held from a LOCAL owner's perspective: `(owner, channel)` where
 * `owner` is a local handle and `channel` is a channel reference (§2.4) — a bare
 * local `chn_…` id, or a URI (the canonical local channel URI, or a remote
 * channel's URI). `(owner, channel)` is the primary key, so following the same
 * channel twice is a no-op ({@link addFollow} is idempotent against it).
 */
import { type Follow, FollowSchema, type MetadataList, rfc3339Timestamp } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type FollowRow, follows } from "../db/schema.ts";

/** Map a stored follow row to the canonical, schema-valid `Follow` (§7.6). */
export function rowToFollow(row: FollowRow): Follow {
  const metadata = JSON.parse(row.metadata) as MetadataList;
  return FollowSchema.parse({
    channel: row.channel,
    ...(row.groupId != null ? { groupId: row.groupId } : {}),
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    metadata,
  });
}

/** The raw follow row for (owner, channel), or `null` if there is none. */
export function getFollowRow(db: Db, owner: string, channel: string): FollowRow | null {
  return (
    db.drizzle
      .select()
      .from(follows)
      .where(and(eq(follows.owner, owner), eq(follows.channel, channel)))
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Start following `channel` for `owner`. Idempotent on (owner, channel): if the
 * follow already exists the existing row is returned unchanged (no duplicate,
 * `groupId`/`createdAt` preserved). Returns `{ follow, created }` so the HTTP
 * layer can pick the 201 (new) vs 200 (existing) status (§7.6).
 */
export function addFollow(
  db: Db,
  owner: string,
  channel: string,
  groupId: string | null,
): { follow: Follow; created: boolean } {
  const existing = getFollowRow(db, owner, channel);
  if (existing) return { follow: rowToFollow(existing), created: false };

  const row: FollowRow = {
    owner,
    channel,
    groupId,
    createdAt: Date.now(),
    metadata: JSON.stringify([]),
  };
  db.drizzle.insert(follows).values(row).run();
  return { follow: rowToFollow(row), created: true };
}

/**
 * Stop following `channel` for `owner`. Returns true if a row was removed, false
 * if there was nothing to remove (the HTTP layer treats both as success, §7.6).
 */
export function removeFollow(db: Db, owner: string, channel: string): boolean {
  const existing = getFollowRow(db, owner, channel);
  if (!existing) return false;
  db.drizzle
    .delete(follows)
    .where(and(eq(follows.owner, owner), eq(follows.channel, channel)))
    .run();
  return true;
}

/** All of `owner`'s follows, oldest-first. */
export function listFollows(db: Db, owner: string): Follow[] {
  return db.drizzle
    .select()
    .from(follows)
    .where(eq(follows.owner, owner))
    .orderBy(follows.createdAt)
    .all()
    .map(rowToFollow);
}
