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
 *
 * ## `groupId` is derived, never stored (§7.6)
 * The provider MUST derive a `Follow`'s `groupId` from the channel and MUST
 * ignore one in the request body, so no group is stored with the pointer. It is
 * derived each time the follow is rendered ({@link deriveFollowGroupId}): the
 * local channel's own group (its local id), or, for a remote channel URI, the
 * group's object URI on the channel's authority. Where it cannot be derived (a
 * local channel since deleted, a remote URI not shaped like a channel URI) the
 * `Follow` carries none.
 */
import {
  type Follow,
  FollowSchema,
  type MetadataList,
  canonicalAuthority,
  rfc3339Timestamp,
} from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type FollowRow, follows } from "../db/schema.ts";
import { getChannelRow } from "./channels.ts";

/**
 * The canonical channel object URI path (§2.2):
 * `/api/groups/{groupId}/channels/{channelId}`, each segment a `LocalId`.
 */
const CHANNEL_URI_PATH =
  /^\/api\/groups\/([A-Za-z0-9_-]{1,128})\/channels\/([A-Za-z0-9_-]{1,128})$/;

/**
 * A classified channel ref (§2.4):
 *  - `local`: a bare id, or a URI whose authority is this provider. `channelId`
 *    is `null` for a local URI not shaped like a channel URI; `pathGroupId` is
 *    the group the URI names (`null` for a bare id).
 *  - `remote`: a URI on another provider's `authority` (canonical form), with
 *    the group its path names (`null` when it is not a channel-shaped `https`
 *    URI).
 */
export type ChannelRefTarget =
  | { kind: "local"; channelId: string | null; pathGroupId: string | null }
  | { kind: "remote"; authority: string; groupId: string | null };

/** Classify a channel ref against this provider's `domain` (§2.4). */
export function classifyChannelRef(domain: string, ref: string): ChannelRefTarget {
  if (!(ref.startsWith("https://") || ref.startsWith("http://"))) {
    return { kind: "local", channelId: ref, pathGroupId: null };
  }
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return { kind: "local", channelId: null, pathGroupId: null };
  }
  const m = url.pathname.match(CHANNEL_URI_PATH);
  const authority = canonicalAuthority(url.host);
  if (authority === canonicalAuthority(domain)) {
    return { kind: "local", channelId: m?.[2] ?? null, pathGroupId: m?.[1] ?? null };
  }
  // Object URIs are HTTPS (§2.2); only a channel-shaped one names its group.
  const groupId = url.protocol === "https:" ? (m?.[1] ?? null) : null;
  return { kind: "remote", authority, groupId };
}

/**
 * The `Follow` `groupId` derived from the channel (§7.6), or `null` when it
 * cannot be derived. A local channel → its group's local id (when the ref is a
 * local URI, only if the URI names that group). A remote channel → the group's
 * object URI `https://{authority}/api/groups/{groupId}` on the channel's
 * authority, read from the channel URI.
 */
export function deriveFollowGroupId(db: Db, domain: string, channel: string): string | null {
  const target = classifyChannelRef(domain, channel);
  if (target.kind === "remote") {
    return target.groupId === null
      ? null
      : `https://${target.authority}/api/groups/${target.groupId}`;
  }
  if (target.channelId === null) return null;
  const row = getChannelRow(db, target.channelId);
  if (!row) return null;
  if (target.pathGroupId !== null && target.pathGroupId !== row.groupId) return null;
  return row.groupId;
}

/**
 * Map a stored follow row to the canonical, schema-valid `Follow` (§7.6), with
 * its `groupId` derived from the channel ({@link deriveFollowGroupId}).
 */
export function rowToFollow(db: Db, domain: string, row: FollowRow): Follow {
  const metadata = JSON.parse(row.metadata) as MetadataList;
  const groupId = deriveFollowGroupId(db, domain, row.channel);
  return FollowSchema.parse({
    channel: row.channel,
    ...(groupId !== null ? { groupId } : {}),
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
 * `createdAt` preserved). Returns `{ follow, created }` so the HTTP layer can
 * pick the 201 (new) vs 200 (existing) status (§7.6). `domain` is this
 * provider's, for deriving the `groupId`.
 */
export function addFollow(
  db: Db,
  domain: string,
  owner: string,
  channel: string,
): { follow: Follow; created: boolean } {
  const existing = getFollowRow(db, owner, channel);
  if (existing) return { follow: rowToFollow(db, domain, existing), created: false };

  const row: FollowRow = {
    owner,
    channel,
    createdAt: Date.now(),
    metadata: JSON.stringify([]),
  };
  db.drizzle.insert(follows).values(row).run();
  return { follow: rowToFollow(db, domain, row), created: true };
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

/** All of `owner`'s follows, oldest-first, each `groupId` derived (§7.6). */
export function listFollows(db: Db, domain: string, owner: string): Follow[] {
  return db.drizzle
    .select()
    .from(follows)
    .where(eq(follows.owner, owner))
    .orderBy(follows.createdAt)
    .all()
    .map((row) => rowToFollow(db, domain, row));
}
