/**
 * Channel storage + canonical-shape mapping (spec §5.2, §5.5).
 *
 * Owns the persistence helpers the `/api/groups/:groupId/channels` router builds
 * on, keeping the HTTP layer thin: row ↔ canonical `Channel` translation,
 * default application on create, partial update (with `type` held immutable),
 * deletion, and the group-scoped channel listing. The group-membership /
 * permission resolver (`provider/permissions.ts`) is consulted by the HTTP layer
 * for authorization; this module owns the `channels` row lifecycle only.
 *
 * The {@link channelVisibleTo} helper is the single channel-visibility rule
 * (tier + membership), exported so messaging/subscription cards reuse one
 * decision rather than re-deriving it.
 */
import {
  type Channel,
  type ChannelCreateRequest,
  ChannelSchema,
  type ChannelType,
  type ChannelUpdateRequest,
  type MetadataList,
  rfc3339Timestamp,
} from "@forumall/shared";
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type ChannelRow, channels, messages, reactions } from "../db/schema.ts";
import { isMember } from "./permissions.ts";

/** `id` prefix per the §5.2 wire examples (`chn_…`). */
const CHANNEL_ID_PREFIX = "chn_";
/** Random bytes of entropy for a channel id (16 = 128 bits). */
const CHANNEL_ID_BYTES = 16;

/** Tiers that make a channel readable without group membership (§5.5). */
const PUBLIC_TIERS = new Set(["public", "discoverable"]);

/** RECOMMENDED defaults when create-request fields are omitted (§5.5). */
const DEFAULT_TIER = "private";

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated channel id (`chn_<base64url>`). */
function mintChannelId(): string {
  const raw = new Uint8Array(CHANNEL_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${CHANNEL_ID_PREFIX}${toBase64Url(raw)}`;
}

/** Map a stored row to the canonical, schema-valid `Channel` (§5.2). */
export function rowToChannel(row: ChannelRow): Channel {
  const tags = JSON.parse(row.tags) as string[];
  const metadata = JSON.parse(row.metadata) as MetadataList;
  return ChannelSchema.parse({
    id: row.id,
    groupId: row.groupId,
    ...(row.name != null ? { name: row.name } : {}),
    type: row.type as ChannelType,
    tier: row.tier,
    ...(row.topic != null ? { topic: row.topic } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    // A call channel carries a derived, read-time call summary (§9). Calls are
    // otherwise deferred, so this is a static projection: nothing is live yet.
    ...(row.type === "call" ? { call: { active: false, participants: [] } } : {}),
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    updatedAt: rfc3339Timestamp(new Date(row.updatedAt)),
    metadata,
  });
}

/** The raw stored row for `channelId`, or `null` if there is none. */
export function getChannelRow(db: Db, channelId: string): ChannelRow | null {
  return (
    db.drizzle.select().from(channels).where(eq(channels.id, channelId)).limit(1).all()[0] ?? null
  );
}

/** All raw channel rows of `groupId` (unfiltered by visibility). */
export function listChannelRows(db: Db, groupId: string): ChannelRow[] {
  return db.drizzle.select().from(channels).where(eq(channels.groupId, groupId)).all();
}

/**
 * Whether a channel of `tier` in group `groupId` is visible to `actor`
 * (`handle@domain`, or `null`/`undefined` for an anonymous caller).
 *
 * The single channel-visibility rule, consistent with group reads (§5.5):
 *  - a `public`/`discoverable` channel is visible to anyone (caller in a
 *    readable group is assumed — the caller already passed the group read gate);
 *  - a `private`/`group` channel is visible only to an authenticated group
 *    member.
 *
 * Exported so messaging/subscription cards reuse one decision.
 */
export function channelVisibleTo(
  db: Db,
  groupId: string,
  tier: string,
  actor: string | null | undefined,
): boolean {
  if (PUBLIC_TIERS.has(tier)) return true;
  return actor != null && isMember(db, groupId, actor);
}

/**
 * Create a channel in `groupId`, applying the §5.5 defaults for any omitted
 * field. `type` is REQUIRED in the request and fixed here. Returns the canonical
 * `Channel`. Authorization (group `manage`) is the caller's responsibility.
 */
export function createChannel(db: Db, groupId: string, req: ChannelCreateRequest): Channel {
  const now = Date.now();
  const row: ChannelRow = {
    id: mintChannelId(),
    groupId,
    name: req.name ?? null,
    type: req.type,
    tier: req.tier ?? DEFAULT_TIER,
    topic: req.topic ?? null,
    tags: JSON.stringify(req.tags ?? []),
    metadata: JSON.stringify(req.metadata ?? []),
    createdAt: now,
    updatedAt: now,
  };
  db.drizzle.insert(channels).values(row).run();
  return rowToChannel(row);
}

/**
 * Apply a partial update to `channelId` (name/tier/topic/tags/metadata), bumping
 * `updated_at`. `type` is immutable and is never written here. Returns the
 * updated canonical `Channel`, or `null` if the channel does not exist.
 * Authorization is the caller's responsibility (`canActor("manage", …)`).
 */
export function updateChannel(
  db: Db,
  channelId: string,
  req: ChannelUpdateRequest,
): Channel | null {
  const existing = getChannelRow(db, channelId);
  if (!existing) return null;

  const patch: Partial<ChannelRow> = { updatedAt: Date.now() };
  if (req.name !== undefined) patch.name = req.name;
  if (req.tier !== undefined) patch.tier = req.tier;
  if (req.topic !== undefined) patch.topic = req.topic;
  if (req.tags !== undefined) patch.tags = JSON.stringify(req.tags);
  if (req.metadata !== undefined) patch.metadata = JSON.stringify(req.metadata);

  db.drizzle.update(channels).set(patch).where(eq(channels.id, channelId)).run();
  return rowToChannel(getChannelRow(db, channelId) as ChannelRow);
}

/**
 * Delete `channelId`. Returns true if a channel was deleted, false if it did not
 * exist. Authorization is the caller's responsibility.
 */
export function deleteChannel(db: Db, channelId: string): boolean {
  const existing = getChannelRow(db, channelId);
  if (!existing) return false;
  db.sqlite.transaction(() => {
    db.drizzle.delete(reactions).where(eq(reactions.channelId, channelId)).run();
    db.drizzle.delete(messages).where(eq(messages.channelId, channelId)).run();
    db.drizzle.delete(channels).where(eq(channels.id, channelId)).run();
  })();
  return true;
}
