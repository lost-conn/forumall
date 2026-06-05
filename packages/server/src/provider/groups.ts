/**
 * Group storage + canonical-shape mapping (spec §5.2, §5.5).
 *
 * Owns the persistence helpers the `/api/groups` router builds on, keeping the
 * HTTP layer thin: row ↔ canonical `Group` translation, default application on
 * create, partial update, and deletion (group + its members + its channels,
 * which cascade on delete). The permission resolver (`provider/permissions.ts`)
 * reads memberships separately; this module owns the `groups`/`group_members`
 * row lifecycle.
 */
import {
  type Group,
  type GroupCreateRequest,
  type GroupPermissions,
  GroupSchema,
  type GroupUpdateRequest,
  type JoinPolicy,
  type MetadataList,
  rfc3339Timestamp,
} from "@forumall/shared";
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type GroupRow, channels, groupMembers, groups, joinRequests } from "../db/schema.ts";

/** `id` prefix per the §5.2 wire examples (`grp_…`). */
const GROUP_ID_PREFIX = "grp_";
/** Random bytes of entropy for a group id (16 = 128 bits). */
const GROUP_ID_BYTES = 16;

/** RECOMMENDED defaults when create-request fields are omitted (§5.5). */
const DEFAULT_TIER = "private";
const DEFAULT_JOIN_POLICY: JoinPolicy = "invite";
const DEFAULT_PERMISSIONS: GroupPermissions = {
  post: ["member"],
  moderate: ["admin"],
  manage: ["admin"],
};

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated group id (`grp_<base64url>`). */
function mintGroupId(): string {
  const raw = new Uint8Array(GROUP_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${GROUP_ID_PREFIX}${toBase64Url(raw)}`;
}

/** Map a stored row to the canonical, schema-valid `Group` (§5.2). */
export function rowToGroup(row: GroupRow): Group {
  const permissions = JSON.parse(row.permissions) as GroupPermissions;
  const metadata = JSON.parse(row.metadata) as MetadataList;
  return GroupSchema.parse({
    id: row.id,
    name: row.name,
    ...(row.description != null ? { description: row.description } : {}),
    owner: row.owner,
    joinPolicy: row.joinPolicy as JoinPolicy,
    tier: row.tier,
    permissions,
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
    updatedAt: rfc3339Timestamp(new Date(row.updatedAt)),
    metadata,
  });
}

/** The raw stored row for `groupId`, or `null` if there is none. */
export function getGroupRow(db: Db, groupId: string): GroupRow | null {
  return db.drizzle.select().from(groups).where(eq(groups.id, groupId)).limit(1).all()[0] ?? null;
}

/**
 * Create a group owned by `owner` (canonical `handle@domain`), applying the
 * §5.5 defaults for any omitted field, and insert `owner` as the `owner`
 * member. Returns the canonical `Group`.
 */
export function createGroup(db: Db, owner: string, req: GroupCreateRequest): Group {
  const now = Date.now();
  const row: GroupRow = {
    id: mintGroupId(),
    name: req.name,
    description: req.description ?? null,
    owner,
    joinPolicy: req.joinPolicy ?? DEFAULT_JOIN_POLICY,
    tier: req.tier ?? DEFAULT_TIER,
    permissions: JSON.stringify(req.permissions ?? DEFAULT_PERMISSIONS),
    metadata: JSON.stringify(req.metadata ?? []),
    createdAt: now,
    updatedAt: now,
  };

  db.sqlite.transaction(() => {
    db.drizzle.insert(groups).values(row).run();
    db.drizzle
      .insert(groupMembers)
      .values({ groupId: row.id, user: owner, role: "owner", joinedAt: now })
      .run();
  })();

  return rowToGroup(row);
}

/**
 * Apply a partial update to `groupId` (name/description/tier/joinPolicy/
 * permissions/metadata), bumping `updated_at`. Returns the updated canonical
 * `Group`, or `null` if the group does not exist. Authorization is the caller's
 * responsibility (`canActor("manage", …)`).
 */
export function updateGroup(db: Db, groupId: string, req: GroupUpdateRequest): Group | null {
  const existing = getGroupRow(db, groupId);
  if (!existing) return null;

  const patch: Partial<GroupRow> = { updatedAt: Date.now() };
  if (req.name !== undefined) patch.name = req.name;
  if (req.description !== undefined) patch.description = req.description;
  if (req.tier !== undefined) patch.tier = req.tier;
  if (req.joinPolicy !== undefined) patch.joinPolicy = req.joinPolicy;
  if (req.permissions !== undefined) patch.permissions = JSON.stringify(req.permissions);
  if (req.metadata !== undefined) patch.metadata = JSON.stringify(req.metadata);

  db.drizzle.update(groups).set(patch).where(eq(groups.id, groupId)).run();
  return rowToGroup(getGroupRow(db, groupId) as GroupRow);
}

/**
 * Delete `groupId` and its membership rows, cascading to its channels (§5.5).
 * Returns true if a group was deleted, false if it did not exist.
 */
export function deleteGroup(db: Db, groupId: string): boolean {
  const existing = getGroupRow(db, groupId);
  if (!existing) return false;
  db.sqlite.transaction(() => {
    db.drizzle.delete(channels).where(eq(channels.groupId, groupId)).run();
    db.drizzle.delete(groupMembers).where(eq(groupMembers.groupId, groupId)).run();
    db.drizzle.delete(joinRequests).where(eq(joinRequests.groupId, groupId)).run();
    db.drizzle.delete(groups).where(eq(groups.id, groupId)).run();
  })();
  return true;
}
