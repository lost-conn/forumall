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
 * `owner` is a local handle and `channel` is a channel reference (§2.2).
 * `(owner, channel)` is the primary key, so following the same channel twice is
 * a no-op ({@link addFollow} is idempotent against it).
 *
 * ## One stored spelling per channel (§2.2)
 * A ref is a local id or an HTTPS object URI, and a provider receiving its own
 * object URI MUST treat it exactly like the equivalent local id. So the stored
 * `channel` is the **bare local id** for a local channel — whether it was named
 * by id or by this provider's channel URI — and the URI as given for a remote
 * channel ({@link followKey}). Adding, removing and looking up all go through
 * the same key, so an id and its own URI are one follow. A ref that is neither
 * (a non-`https` URI, one with a query or fragment, a value that is not a local
 * id) is `invalid` and the HTTP layer answers `400`.
 *
 * ## `groupId` is derived, never stored (§7.6)
 * The provider MUST derive a `Follow`'s `groupId` from the channel and MUST
 * ignore one in the request body, so no group is stored with the pointer. It is
 * derived each time the follow is rendered ({@link deriveFollowGroupId}): the
 * local channel's own group (its local id), or, for a remote channel URI, the
 * group's object URI on the channel's authority. A local channel's group is
 * derived only while the follow's owner can READ the channel (§11.3): one since
 * deleted and one the owner has lost access to both carry no `groupId`, so the
 * follow list never tells a removed member whether a hidden channel still
 * exists. A remote URI not shaped like a channel URI carries none either.
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
import { getChannelRow, getReadableChannel } from "./channels.ts";

/** A local id (§2.2): path-safe, so a ref matching it is never a URI. */
const LOCAL_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The canonical channel object URI path (§2.2):
 * `/api/groups/{groupId}/channels/{channelId}`, each segment a `LocalId`.
 */
const CHANNEL_URI_PATH =
  /^\/api\/groups\/([A-Za-z0-9_-]{1,128})\/channels\/([A-Za-z0-9_-]{1,128})$/;

/**
 * A classified channel ref (§2.2):
 *  - `local`: a bare local id, or an object URI whose authority is this
 *    provider. `channelId` is `null` for a local URI not shaped like a channel
 *    URI; `pathGroupId` is the group the URI names (`null` for a bare id).
 *  - `remote`: an object URI on another provider's `authority` (canonical
 *    form), kept as given in `uri`, with the group its path names (`null` when
 *    it is not shaped like a channel URI).
 *  - `invalid`: neither a local id nor an HTTPS object URI without query or
 *    fragment; `reason` says which rule it breaks.
 */
export type ChannelRefTarget =
  | { kind: "local"; channelId: string | null; pathGroupId: string | null }
  | { kind: "remote"; uri: string; authority: string; groupId: string | null }
  | { kind: "invalid"; reason: string };

/** Classify a channel ref against this provider's `domain` (§2.2). */
export function classifyChannelRef(domain: string, ref: string): ChannelRefTarget {
  if (LOCAL_ID.test(ref)) return { kind: "local", channelId: ref, pathGroupId: null };
  if (!ref.startsWith("https://")) {
    return {
      kind: "invalid",
      reason: "a channel ref is a local id or an https object URI (OFSCP §2.2)",
    };
  }
  if (ref.includes("?") || ref.includes("#")) {
    return {
      kind: "invalid",
      reason: "a channel object URI carries no query or fragment (OFSCP §2.2)",
    };
  }
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return { kind: "invalid", reason: "a channel object URI must be an absolute URL (OFSCP §2.2)" };
  }
  const m = url.pathname.match(CHANNEL_URI_PATH);
  const authority = canonicalAuthority(url.host);
  if (authority === canonicalAuthority(domain)) {
    return { kind: "local", channelId: m?.[2] ?? null, pathGroupId: m?.[1] ?? null };
  }
  return { kind: "remote", uri: ref, authority, groupId: m?.[1] ?? null };
}

/**
 * The stored `channel` for a valid ref (§2.2): a local channel's bare id, a
 * remote channel's URI as given. `null` when the ref names no channel that could
 * be followed: a local URI not shaped like a channel URI, or a local channel URI
 * naming a group the (existing) channel is not in — neither is the equivalent of
 * any local id.
 */
export function followKey(
  db: Db,
  target: Exclude<ChannelRefTarget, { kind: "invalid" }>,
): string | null {
  if (target.kind === "remote") return target.uri;
  if (target.channelId === null) return null;
  if (target.pathGroupId !== null) {
    const row = getChannelRow(db, target.channelId);
    if (row && row.groupId !== target.pathGroupId) return null;
  }
  return target.channelId;
}

/** The actor (`handle@domain`, §2.2) of local follow owner `owner`. */
function ownerActor(domain: string, owner: string): string {
  return `${owner}@${canonicalAuthority(domain)}`;
}

/**
 * The `Follow` `groupId` derived from the stored `channel` (§7.6), or `null`
 * when it cannot be derived. A local channel → its group's local id, but only
 * while `owner` (an actor) can read it (§11.3: an unreadable channel answers
 * exactly as a deleted one). A remote channel → the group's object URI
 * `https://{authority}/api/groups/{groupId}` on the channel's authority, read
 * from the channel URI.
 */
export function deriveFollowGroupId(
  db: Db,
  domain: string,
  owner: string,
  channel: string,
): string | null {
  const target = classifyChannelRef(domain, channel);
  if (target.kind === "invalid") return null;
  if (target.kind === "remote") {
    return target.groupId === null
      ? null
      : `https://${target.authority}/api/groups/${target.groupId}`;
  }
  if (target.channelId === null) return null;
  const row = getReadableChannel(db, target.channelId, owner, target.pathGroupId ?? undefined);
  return row?.groupId ?? null;
}

/**
 * Map a stored follow row to the canonical, schema-valid `Follow` (§7.6), with
 * its `groupId` derived from the channel ({@link deriveFollowGroupId}).
 */
export function rowToFollow(db: Db, domain: string, row: FollowRow): Follow {
  const metadata = JSON.parse(row.metadata) as MetadataList;
  const groupId = deriveFollowGroupId(db, domain, ownerActor(domain, row.owner), row.channel);
  return FollowSchema.parse({
    channel: row.channel,
    ...(groupId !== null ? { groupId } : {}),
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    metadata,
  });
}

/** The raw follow row for (owner, stored channel key), or `null` if none. */
function getFollowRow(db: Db, owner: string, key: string): FollowRow | null {
  return (
    db.drizzle
      .select()
      .from(follows)
      .where(and(eq(follows.owner, owner), eq(follows.channel, key)))
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Start following the channel stored under `key` ({@link followKey}) for
 * `owner`. Idempotent on (owner, key): if the follow already exists the
 * existing row is returned unchanged (no duplicate, `createdAt` preserved).
 * Returns `{ follow, created }` so the HTTP layer can pick the 201 (new) vs 200
 * (existing) status (§7.6). `domain` is this provider's, for deriving the
 * `groupId`.
 */
export function addFollow(
  db: Db,
  domain: string,
  owner: string,
  key: string,
): { follow: Follow; created: boolean } {
  const existing = getFollowRow(db, owner, key);
  if (existing) return { follow: rowToFollow(db, domain, existing), created: false };

  const row: FollowRow = {
    owner,
    channel: key,
    createdAt: Date.now(),
    metadata: JSON.stringify([]),
  };
  db.drizzle.insert(follows).values(row).run();
  return { follow: rowToFollow(db, domain, row), created: true };
}

/**
 * Stop following the channel stored under `key` ({@link followKey}) for
 * `owner`. Returns true if a row was removed, false if there was nothing to
 * remove (the HTTP layer treats both as success, §7.6).
 */
export function removeFollow(db: Db, owner: string, key: string): boolean {
  const existing = getFollowRow(db, owner, key);
  if (!existing) return false;
  db.drizzle
    .delete(follows)
    .where(and(eq(follows.owner, owner), eq(follows.channel, key)))
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
