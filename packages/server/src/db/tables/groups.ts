/**
 * Drizzle tables — Groups, members, channels, join requests and invites (§5).
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Groups (spec §5.2). The canonical container object. Channels are NOT embedded
 * (fetched separately, §5.5), so this row stays stable regardless of channel
 * count.
 *
 * `owner` is the canonical actor (`handle@domain`) who created the group; on
 * create, the same actor is also inserted into {@link groupMembers} with the
 * `owner` role. `permissions` and `metadata` are stored as JSON text (mapped to
 * the shared `GroupPermissions` / `MetadataList` shapes at the HTTP boundary).
 * `joinPolicy` is `open|request|invite` (§5.2); `tier` is an open string
 * (§11) — the canonical values are `private|group|public|discoverable`.
 */
export const groups = sqliteTable("groups", {
  /** Stable group id, e.g. `grp_<base64url>`. Primary key. */
  id: text("id").primaryKey(),
  /** Display name (REQUIRED at create). */
  name: text("name").notNull(),
  /** Optional human description. */
  description: text("description"),
  /** Optional avatar image URL (https://; served from /api/media). */
  avatar: text("avatar"),
  /** Owning actor (`handle@domain`). */
  owner: text("owner").notNull(),
  /** Join policy: `open` | `request` | `invite`. */
  joinPolicy: text("join_policy").notNull(),
  /** Access/discoverability tier (open string; §11). */
  tier: text("tier").notNull(),
  /** Action→roles permission map, stored as JSON (`GroupPermissions`). */
  permissions: text("permissions").notNull(),
  /** Custom role catalogue, stored as JSON (`RoleDefinition[]`, §5.2). */
  roles: text("roles").notNull(),
  /** Extension metadata list, stored as JSON (`MetadataList`). */
  metadata: text("metadata").notNull(),
  /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
  /** Last-update time (epoch millis); rendered as RFC 3339 `updatedAt`. */
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type GroupRow = typeof groups.$inferSelect;
export type NewGroupRow = typeof groups.$inferInsert;

/**
 * Group membership (spec §5.2). One row per (group, user). `role` is an open
 * string; canonical roles are `owner|admin|member|guest` ranked
 * owner > admin > member > guest by the permission resolver
 * (`provider/permissions.ts`). On group create, the creator is inserted here as
 * `owner`. The membership card extends these tables.
 */
export const groupMembers = sqliteTable(
  "group_members",
  {
    /** FK to `groups.id`. */
    groupId: text("group_id").notNull(),
    /** Member actor (`handle@domain`). */
    user: text("user").notNull(),
    /** Membership role: `owner` | `admin` | `member` | `guest`. */
    role: text("role").notNull(),
    /**
     * Per-group display-name override (Discord-server-nickname style): overrides
     * the member's GLOBAL `UserProfile.displayName` within THIS group only.
     * Nullable — NULL/absent means "use the global display name". Added in
     * migration 0025.
     */
    displayNameOverride: text("display_name_override"),
    /** Join time (epoch millis); rendered as RFC 3339 `joinedAt`. */
    joinedAt: integer("joined_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.user] }),
  }),
);

export type GroupMemberRow = typeof groupMembers.$inferSelect;
export type NewGroupMemberRow = typeof groupMembers.$inferInsert;

/**
 * Channels (spec §5.2, §5.5). A channel belongs to one group (`group_id` FK →
 * `groups.id`) and carries its own access `tier` (§11), independent of the
 * group's. `type` is `text|call` and is immutable after creation (§5.2). `tags`
 * and `metadata` are stored as JSON text and mapped to the shared `Channel`
 * shape at the HTTP boundary; a `call`-type channel's derived `call` summary is
 * a read-time projection, never stored here (§9). Deleting the owning group
 * cascades to its channels (`provider/groups.ts`).
 */
export const channels = sqliteTable(
  "channels",
  {
    /** Stable channel id, e.g. `chn_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** FK to `groups.id`. */
    groupId: text("group_id").notNull(),
    /** Optional display name. */
    name: text("name"),
    /** Channel kind: `text` | `call`. Immutable after create (§5.2). */
    type: text("type").notNull(),
    /** Access/discoverability tier (open string; §11). */
    tier: text("tier").notNull(),
    /** Optional topic / description. */
    topic: text("topic"),
    /** Tag list, stored as JSON (`string[]`). */
    tags: text("tags").notNull(),
    /**
     * Optional per-channel permission overrides, stored as JSON
     * (`ChannelPermissions`, §5.2.1). Null/absent → inherit group permissions
     * and tier. Added in migration 0022.
     */
    permissions: text("permissions"),
    /** Extension metadata list, stored as JSON (`MetadataList`). */
    metadata: text("metadata").notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Last-update time (epoch millis); rendered as RFC 3339 `updatedAt`. */
    updatedAt: integer("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    groupIdx: index("idx_channels_group_id").on(t.groupId),
  }),
);

export type ChannelRow = typeof channels.$inferSelect;
export type NewChannelRow = typeof channels.$inferInsert;

/**
 * Pending join requests (spec §5.7). One row per request to join a
 * `request`-policy group. A request starts `pending`; approving creates the
 * membership and marks the request `approved`, denying marks it `denied`. The
 * pending request is idempotent per (group, user): a second join while one is
 * pending returns the existing row rather than inserting a duplicate (enforced
 * in `provider/membership.ts`).
 *
 * `user` is the canonical actor (`handle@domain`). `state` is `pending`|
 * `approved`|`denied` (matching the shared `JoinRequest` schema). `message` is
 * the optional note supplied with the join request. Deleting the owning group
 * cascades to its join requests (`provider/groups.ts`).
 */
export const joinRequests = sqliteTable(
  "join_requests",
  {
    /** Stable request id, e.g. `jrq_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** FK to `groups.id`. */
    groupId: text("group_id").notNull(),
    /** Requesting actor (`handle@domain`). */
    user: text("user").notNull(),
    /** Request state: `pending` | `approved` | `denied`. */
    state: text("state").notNull(),
    /** Optional message accompanying the request. */
    message: text("message"),
    /** Request time (epoch millis); rendered as RFC 3339 `requestedAt`. */
    requestedAt: integer("requested_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    groupIdx: index("idx_join_requests_group_id").on(t.groupId),
  }),
);

export type JoinRequestRow = typeof joinRequests.$inferSelect;
export type NewJoinRequestRow = typeof joinRequests.$inferInsert;

/**
 * Invites / join links (spec §5.6). One row per invite. `token` is a
 * high-entropy opaque secret embedded in the shareable link
 * (`https://{domain}/invite/{token}`); redeeming it joins the issuing group (or
 * a specific `channel_id`) with `role` (default `member`) without per-person
 * approval. An invite MAY be multi-use (`max_uses`), time-limited
 * (`expires_at`), and MAY provision a provider-local guest account
 * (`grants_guest`, §4.8). `uses` counts redemptions and is incremented
 * atomically against `max_uses`.
 *
 * `created_by` is the canonical actor (`handle@domain`) that minted it. Deleting
 * the owning group cascades to its invites (`provider/groups.ts`).
 */
export const invites = sqliteTable(
  "invites",
  {
    /** Stable invite id, e.g. `inv_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** FK to `groups.id`. */
    groupId: text("group_id").notNull(),
    /** High-entropy opaque secret embedded in the join link. Unique. */
    token: text("token").notNull().unique(),
    /** Optional FK to `channels.id`: redeem joins this channel's group. */
    channelId: text("channel_id"),
    /** Role granted on redemption (`owner|admin|member|guest`). Default member. */
    role: text("role").notNull().default("member"),
    /** Whether this invite may provision a guest account (§4.8). */
    grantsGuest: integer("grants_guest", { mode: "boolean" }).notNull().default(false),
    /** Optional max redemptions; null = unlimited. */
    maxUses: integer("max_uses", { mode: "number" }),
    /** Redemption count (incremented atomically). */
    uses: integer("uses", { mode: "number" }).notNull().default(0),
    /** Optional expiry (epoch millis); rejected once `now >= expires_at`. */
    expiresAt: integer("expires_at", { mode: "number" }),
    /** Minting actor (`handle@domain`). */
    createdBy: text("created_by").notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    tokenIdx: index("idx_invites_token").on(t.token),
    groupIdx: index("idx_invites_group_id").on(t.groupId),
  }),
);

export type InviteRow = typeof invites.$inferSelect;
export type NewInviteRow = typeof invites.$inferInsert;
