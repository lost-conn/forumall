/**
 * Drizzle table definitions (bun:sqlite dialect).
 *
 * Intentionally minimal for the P2 skeleton: only `app_meta`, a key/value
 * store used to exercise the migration path and hold provider-level metadata
 * (schema version, instance id, etc.). Domain tables (users, device_keys,
 * groups, …) are added by their respective feature cards — do NOT add them
 * here, to avoid overlap.
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Provider-level key/value metadata. */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type AppMetaRow = typeof appMeta.$inferSelect;
export type NewAppMetaRow = typeof appMeta.$inferInsert;

/**
 * The provider's own Ed25519 signing identity (spec §8.1), distinct from user
 * device keys. Generated once on first boot and reused across restarts. The
 * `private_key` column is internal-only and MUST never appear in an HTTP
 * response — only the `public_key` is published in discovery (§3.1). Multiple
 * rows are allowed to support future key rotation.
 */
export const providerKeys = sqliteTable("provider_keys", {
  /** Stable identifier, e.g. `psk-<short>`. Published as `key_id`. */
  keyId: text("key_id").primaryKey(),
  /** Base64 raw 32-byte Ed25519 public key. Published in discovery. */
  publicKey: text("public_key").notNull(),
  /** Base64 raw 32-byte Ed25519 private seed. Secret; never served. */
  privateKey: text("private_key").notNull(),
  /** Always `Ed25519` in v0.1; column exists to support future algorithms. */
  algorithm: text("algorithm").notNull(),
  /** Creation time (epoch millis); rendered as RFC 3339 `created_at`. */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type ProviderKeyRow = typeof providerKeys.$inferSelect;
export type NewProviderKeyRow = typeof providerKeys.$inferInsert;

/**
 * Local user accounts (spec §4.1). The canonical users table that later cards
 * (device keys, profiles, …) extend or reference via `handle`.
 *
 * `handle` is the primary key and the stable, provider-scoped identifier
 * (lowercase alnum / `_` / `-`). `password_hash` is an Argon2id PHC string
 * (§4.1.4) — verification is fully self-contained (salt + params embedded), so
 * no separate salt/params columns are needed. The hash is internal-only and
 * MUST never appear in an HTTP response.
 *
 * `password_hash` is **nullable**: guest accounts (§4.8) authenticate with a
 * device key only and have no password. A `guest` row also MAY carry an
 * `expires_at` (after which the provider SHOULD revoke it) and a `display_name`.
 */
export const users = sqliteTable("users", {
  /** Provider-scoped handle, e.g. `alice`. Primary key + unique identity. */
  handle: text("handle").primaryKey(),
  /**
   * Argon2id PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`). Secret.
   * Nullable: guest accounts (§4.8) have no password (device key is the only
   * credential).
   */
  passwordHash: text("password_hash"),
  /** Optional recovery email for account recovery (§4.1.3). */
  recoveryEmail: text("recovery_email"),
  /** Guest-account flag (§4.8). 0 = full account, 1 = guest (no password). */
  guest: integer("guest", { mode: "boolean" }).notNull().default(false),
  /** Optional human display name; surfaced on the `UserProfile` (§4.8, §6). */
  displayName: text("display_name"),
  /** Optional account expiry (epoch millis); guests MAY carry one (§4.8). */
  expiresAt: integer("expires_at", { mode: "number" }),
  /** Creation time (epoch millis). */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

/**
 * Bootstrap tokens (spec §4.2). Short-lived, single-use bearer credentials that
 * authorize ONLY `POST /api/auth/device-keys` for the bound `handle`.
 *
 * Only a SHA-256 **hash** of the opaque token is stored (never the plaintext),
 * so a database leak cannot be replayed. The bound `handle` is captured at issue
 * time and is the sole source of truth for which account a device key binds to —
 * clients can never override it. `used_at` is nullable; a non-null value marks
 * the token consumed (single-use).
 */
export const bootstrapTokens = sqliteTable("bootstrap_tokens", {
  /** SHA-256 hash (hex) of the opaque token. Primary key (lookup by hash). */
  tokenHash: text("token_hash").primaryKey(),
  /** The handle that authenticated; the only valid binding for this token. */
  handle: text("handle").notNull(),
  /** Expiry time (epoch millis). Rejected once `now >= expires_at`. */
  expiresAt: integer("expires_at", { mode: "number" }).notNull(),
  /** Issue time (epoch millis). */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
  /** Consumption time (epoch millis); null while unused. Single-use marker. */
  usedAt: integer("used_at", { mode: "number" }),
});

export type BootstrapTokenRow = typeof bootstrapTokens.$inferSelect;
export type NewBootstrapTokenRow = typeof bootstrapTokens.$inferInsert;

/**
 * User device keys (spec §4.3). Each row is an Ed25519 public key registered to
 * a local user `handle`; the corresponding private key never leaves the client.
 * All authenticated requests are signed with one of these keys (§4.4), and the
 * non-revoked set is published at `/.well-known/ofscp/users/{handle}/keys` (§4.6).
 *
 * The `handle` binding is taken from the consumed bootstrap token, never from
 * client input (§4.3.1). `revoked` is a soft-delete flag: a revoked key is
 * retained for audit but omitted from the keys endpoint and from actor-key
 * resolution (§4.7.1).
 */
export const deviceKeys = sqliteTable("device_keys", {
  /** Provider-generated stable id, e.g. `dk_<base64url>`. Primary key. */
  keyId: text("key_id").primaryKey(),
  /** Owning user handle (bound from the bootstrap token, never the client). */
  userHandle: text("user_handle").notNull(),
  /** Base64 raw 32-byte Ed25519 public key. */
  publicKey: text("public_key").notNull(),
  /** Always `Ed25519` in v0.1 (§4.3.3). */
  algorithm: text("algorithm").notNull(),
  /** Human-readable device description (`device_name`). */
  deviceName: text("device_name").notNull(),
  /** Creation time (epoch millis); rendered as RFC 3339 `created_at`. */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
  /** Soft-delete flag (§4.7.1). 0 = active, 1 = revoked. */
  revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
});

export type DeviceKeyRow = typeof deviceKeys.$inferSelect;
export type NewDeviceKeyRow = typeof deviceKeys.$inferInsert;

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
  /** Owning actor (`handle@domain`). */
  owner: text("owner").notNull(),
  /** Join policy: `open` | `request` | `invite`. */
  joinPolicy: text("join_policy").notNull(),
  /** Access/discoverability tier (open string; §11). */
  tier: text("tier").notNull(),
  /** Action→roles permission map, stored as JSON (`GroupPermissions`). */
  permissions: text("permissions").notNull(),
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
