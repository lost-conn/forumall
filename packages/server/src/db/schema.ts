/**
 * Drizzle table definitions (bun:sqlite dialect).
 *
 * Intentionally minimal for the P2 skeleton: only `app_meta`, a key/value
 * store used to exercise the migration path and hold provider-level metadata
 * (schema version, instance id, etc.). Domain tables (users, device_keys,
 * groups, …) are added by their respective feature cards — do NOT add them
 * here, to avoid overlap.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
  /** Optional avatar HTTPS URI; surfaced on the `UserProfile` (§5.1, §6.2). */
  avatar: text("avatar"),
  /** Optional bio — a profile "extra" gated by `profileVisibility` (§6.2). */
  bio: text("bio"),
  /** Profile extension metadata, stored as JSON (`MetadataList`). */
  metadata: text("metadata"),
  /** Optional account expiry (epoch millis); guests MAY carry one (§4.8). */
  expiresAt: integer("expires_at", { mode: "number" }),
  /** Creation time (epoch millis). */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
  /** Last profile-update time (epoch millis); rendered as RFC 3339 `updatedAt`. */
  updatedAt: integer("updated_at", { mode: "number" }),
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

/**
 * Messages (spec §5.3, §7.2). One row per chat/memo/article message in a
 * channel. Reactions are a separate object/table (later card), so `type` here
 * is `message|memo|article` only.
 *
 * `content`, `attachments`, `reference`, and `tags` are stored as JSON text and
 * mapped to the shared `Message` shape at the read boundary
 * (`provider/messages.ts`). `reference`/`edited_at`/`deleted_at`/`client_message_id`
 * are nullable.
 *
 * ## Timeline position (`seq`)
 * `seq` is a globally-monotonic integer (assigned `MAX(seq)+1` within the
 * insert transaction) that defines a message's absolute timeline position and
 * is the **basis of the opaque history cursor** (§7.2) — REST history and the
 * WS resume `since` cursor (§7.1) share this one cursor space. The
 * `(channel_id, seq)` index makes per-channel keyset paging over `seq` a range
 * scan. `seq` is globally unique (a UNIQUE index enforces it), so a cursor
 * never collides across channels.
 *
 * `edit_until` is the absolute time (epoch millis) after which the message may
 * no longer be edited (§5.3 `permissions.editUntil`); the WS edit card enforces
 * it. `deleted_at` (nullable) is the tombstone marker (§7.1): a tombstoned
 * message is retained and still returned by history so reply references and
 * resume cursors stay valid — delete itself is a later card.
 *
 * `client_message_id` is reserved for the WS create card's idempotency
 * (`(author, channel_id, client_message_id)` uniqueness); it is nullable and
 * unused by the REST read path. Deleting the owning group/channel cascades to
 * its messages.
 */
export const messages = sqliteTable(
  "messages",
  {
    /** Stable message id, e.g. `msg_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** FK to `channels.id`. */
    channelId: text("channel_id").notNull(),
    /** FK to `groups.id` (denormalized for cascade + group-scoped reads). */
    groupId: text("group_id").notNull(),
    /** Author actor (`handle@domain`). */
    author: text("author").notNull(),
    /** Message kind: `message` | `memo` | `article`. */
    type: text("type").notNull(),
    /** Body, stored as JSON (`{ text, mime }`). */
    content: text("content").notNull(),
    /** Attachment list, stored as JSON (`Attachment[]`). */
    attachments: text("attachments").notNull(),
    /** Optional typed reference (reply etc.), stored as JSON `{ type, id }`. */
    reference: text("reference"),
    /** Tag list, stored as JSON (`string[]`). */
    tags: text("tags").notNull(),
    /** Globally-monotonic timeline position; basis of the §7.2 cursor. */
    seq: integer("seq", { mode: "number" }).notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    /** Last-edit time (epoch millis); null until edited. `editedAt`. */
    editedAt: integer("edited_at", { mode: "number" }),
    /** Tombstone time (epoch millis); null unless deleted. `deletedAt` (§7.1). */
    deletedAt: integer("deleted_at", { mode: "number" }),
    /** Edit-window end (epoch millis); `permissions.editUntil` (§5.3). */
    editUntil: integer("edit_until", { mode: "number" }).notNull(),
    /** Client-supplied idempotency key (WS create card); nullable + unused here. */
    clientMessageId: text("client_message_id"),
  },
  (t) => ({
    channelSeqIdx: index("idx_messages_channel_seq").on(t.channelId, t.seq),
    seqIdx: uniqueIndex("idx_messages_seq").on(t.seq),
    // WS-create idempotency (§7.1): at most one message per
    // (author, channelId, clientMessageId). Partial — only rows that carry an
    // idempotency key participate; keyless messages are unconstrained.
    clientMsgIdx: uniqueIndex("idx_messages_author_channel_client_msg")
      .on(t.author, t.channelId, t.clientMessageId)
      .where(sql`${t.clientMessageId} IS NOT NULL`),
  }),
);

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

/**
 * Reactions (spec §5.3, §7.1). One row per (message, author, key): a user may
 * hold at most ONE reaction per `key` per message, enforced by the unique
 * `(message_id, author, key)` index — `addReaction` is idempotent against it.
 * OFSCP v0.1 does NOT store a server-aggregated count; clients aggregate totals
 * from these rows / the `reaction.added`/`reaction.removed` events (§7.1).
 *
 * `channel_id` / `group_id` are denormalized (from the target message) so the
 * fan-out + authorization paths and cascade deletes do not need a message join.
 * `unicode` / `image` are nullable (a reaction MAY carry either or neither). The
 * canonical `Reaction.reference` is always `{ type: "message", id: message_id }`
 * (re-derived at the read boundary in `provider/reactions.ts`), so no separate
 * reference column is stored. The `message_id` index backs the listing endpoint.
 */
export const reactions = sqliteTable(
  "reactions",
  {
    /** Stable reaction id, e.g. `rct_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** FK to `messages.id` — the reacted-to message. */
    messageId: text("message_id").notNull(),
    /** FK to `channels.id` (denormalized for fan-out + cascade). */
    channelId: text("channel_id").notNull(),
    /** FK to `groups.id` (denormalized for cascade + group-scoped reads). */
    groupId: text("group_id").notNull(),
    /** Reacting actor (`handle@domain`). */
    author: text("author").notNull(),
    /** Reaction key (e.g. `heart`); the dedupe axis with author + message. */
    key: text("key").notNull(),
    /** Optional unicode glyph (e.g. `❤️`). */
    unicode: text("unicode"),
    /** Optional https image/GIF URL. */
    image: text("image"),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // One reaction per (message, author, key): adding the same key again is a
    // no-op (idempotent in `addReaction`).
    uniqueIdx: uniqueIndex("idx_reactions_message_author_key").on(t.messageId, t.author, t.key),
    // Listing reactions for a message (§7.1 history / late-joiners).
    messageIdx: index("idx_reactions_message_id").on(t.messageId),
  }),
);

export type ReactionRow = typeof reactions.$inferSelect;
export type NewReactionRow = typeof reactions.$inferInsert;

/**
 * Media / attachments (spec §5.8). One row per uploaded blob; the raw bytes live
 * in the {@link StorageBackend} (filesystem by default) keyed by `id`, this table
 * holds the metadata that builds the hosted `Attachment` (§5.3, §5.8). `hash` is
 * the content-integrity digest in `<algo>:<base64>` form (`sha-256:…`) so
 * recipients can verify integrity. `width`/`height` are best-effort image
 * dimensions (nullable; absent for non-images). `owner` is the authenticated
 * actor (`handle@domain`) that uploaded the file.
 */
export const media = sqliteTable(
  "media",
  {
    /** Provider-generated stable id, e.g. `att_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** Stored content type (IANA media type), served back on GET. */
    mime: text("mime").notNull(),
    /** Size of the stored blob in bytes. */
    size: integer("size", { mode: "number" }).notNull(),
    /** Optional original filename supplied with the upload. */
    filename: text("filename"),
    /** Content-integrity digest in `<algo>:<base64>` form (`sha-256:…`). */
    hash: text("hash").notNull(),
    /** Best-effort image width in pixels; null for non-images. */
    width: integer("width", { mode: "number" }),
    /** Best-effort image height in pixels; null for non-images. */
    height: integer("height", { mode: "number" }),
    /** Uploading actor (`handle@domain`). */
    owner: text("owner").notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 when needed. */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    ownerIdx: index("idx_media_owner").on(t.owner),
  }),
);

export type MediaRow = typeof media.$inferSelect;
export type NewMediaRow = typeof media.$inferInsert;

/**
 * Direct-message inbox (spec §7.4, §8.3). One row per message stored in a LOCAL
 * recipient's inbox for a conversation. Per §8.3, the recipient's home provider
 * is the SOLE authoritative store — there is NO sender copy — so a DM lives only
 * here, in `owner`'s inbox (`owner` is the local recipient handle).
 *
 * `dm_id` is the deterministic two-party conversation id (`deriveDmId`, §7.4).
 * `author` is the sending actor (`handle@domain`); `content` / `attachments` /
 * `reference` mirror the §5.3 message fields (JSON text). `seq` is the SAME
 * globally-monotonic timeline position used by channel messages (`MAX(seq)+1`
 * across `messages` ∪ `dm_messages`), so the opaque history/`dm.message` cursor
 * is one shared space. `edited_at` / `deleted_at` support author edit/tombstone
 * (§7.1 rules applied to the stored copy). `client_message_id` backs
 * `(owner, dm_id, author, client_message_id)` idempotency (§7.1).
 */
export const dmMessages = sqliteTable(
  "dm_messages",
  {
    /** Stable message id, e.g. `msg_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** Deterministic two-party conversation id (`deriveDmId`, §7.4). */
    dmId: text("dm_id").notNull(),
    /** The LOCAL recipient handle whose inbox this row belongs to. */
    owner: text("owner").notNull(),
    /** Sending actor (`handle@domain`). */
    author: text("author").notNull(),
    /** Body, stored as JSON (`{ text, mime }`). */
    content: text("content").notNull(),
    /** Attachment list, stored as JSON (`Attachment[]`). */
    attachments: text("attachments").notNull(),
    /** Optional typed reference (reply etc.), stored as JSON `{ type, id }`. */
    reference: text("reference"),
    /** Globally-monotonic timeline position; basis of the shared §7.2 cursor. */
    seq: integer("seq", { mode: "number" }).notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    /** Last-edit time (epoch millis); null until edited. `editedAt`. */
    editedAt: integer("edited_at", { mode: "number" }),
    /** Tombstone time (epoch millis); null unless deleted. `deletedAt` (§7.1). */
    deletedAt: integer("deleted_at", { mode: "number" }),
    /** Edit-window end (epoch millis); `permissions.editUntil` (§5.3). */
    editUntil: integer("edit_until", { mode: "number" }).notNull(),
    /** Client-supplied idempotency key; nullable. */
    clientMessageId: text("client_message_id"),
  },
  (t) => ({
    // Per-inbox conversation timeline read (§7.4): keyset paging over `seq`.
    ownerDmSeqIdx: index("idx_dm_messages_owner_dm_seq").on(t.owner, t.dmId, t.seq),
    // Idempotency (§7.1): at most one message per
    // (owner, dmId, author, clientMessageId). Partial — only keyed rows.
    clientMsgIdx: uniqueIndex("idx_dm_messages_owner_dm_author_client_msg")
      .on(t.owner, t.dmId, t.author, t.clientMessageId)
      .where(sql`${t.clientMessageId} IS NOT NULL`),
  }),
);

export type DmMessageRow = typeof dmMessages.$inferSelect;
export type NewDmMessageRow = typeof dmMessages.$inferInsert;

/**
 * Per-inbox DM conversation summary (spec §7.4). One row per (owner, dm_id):
 * upserted whenever a message lands in `owner`'s inbox. Backs the conversation
 * listing (`GET /api/me/dms`) AND participation checks (a row's existence means
 * `owner` is a participant of `dm_id`). `counterparty` is the other actor.
 */
export const dmConversations = sqliteTable(
  "dm_conversations",
  {
    /** The LOCAL recipient handle whose inbox this conversation belongs to. */
    owner: text("owner").notNull(),
    /** Deterministic two-party conversation id (`deriveDmId`, §7.4). */
    dmId: text("dm_id").notNull(),
    /** The other actor in the conversation (`handle@domain`). */
    counterparty: text("counterparty").notNull(),
    /** Last-activity time (epoch millis); rendered as RFC 3339 `updatedAt`. */
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    /** `seq` of the newest message in this inbox conversation. */
    lastMessageSeq: integer("last_message_seq", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.owner, t.dmId] }),
    // Listing the owner's conversations newest-first (§7.4).
    ownerUpdatedIdx: index("idx_dm_conversations_owner_updated").on(t.owner, t.updatedAt),
  }),
);

export type DmConversationRow = typeof dmConversations.$inferSelect;
export type NewDmConversationRow = typeof dmConversations.$inferInsert;

/**
 * Contacts (spec §6.7). A mutually-consented relationship that backs the
 * `contacts` visibility tier (§6.1). One row per (owner, user) FROM the local
 * `owner`'s perspective:
 *
 *  - `owner` is the LOCAL handle whose side of the relationship this row holds.
 *  - `user` is the OTHER actor (`handle@domain`), local or remote.
 *  - `state` is `pending` | `accepted`.
 *  - `direction` is `outgoing` (owner sent the request) | `incoming` (owner
 *    received it); meaningful only while `pending`, retained (but ignored) once
 *    `accepted`.
 *
 * A relationship is `accepted` for the `contacts` tier only once BOTH sides hold
 * an `accepted` row. For a fully-local pair that is both local rows; across
 * providers each provider independently converges its own row via the
 * federation receiver (`POST /api/federation/contacts`). This provider trusts
 * its OWN accepted row when answering the tier (`areContacts`), since that row
 * only reaches `accepted` after the mutual handshake.
 */
export const contacts = sqliteTable(
  "contacts",
  {
    /** The LOCAL handle whose perspective this row holds. */
    owner: text("owner").notNull(),
    /** The other actor (`handle@domain`), local or remote. */
    user: text("user").notNull(),
    /** Relationship state: `pending` | `accepted`. */
    state: text("state").notNull(),
    /** `outgoing` | `incoming`; meaningful while `pending`. */
    direction: text("direction").notNull(),
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
    pk: primaryKey({ columns: [t.owner, t.user] }),
    // Listing an owner's contacts (`GET /api/me/contacts`).
    ownerIdx: index("idx_contacts_owner").on(t.owner),
  }),
);

export type ContactRow = typeof contacts.$inferSelect;
export type NewContactRow = typeof contacts.$inferInsert;

/**
 * Per-user privacy settings (spec §6.6). One row per LOCAL user `handle`. Each
 * `*_visibility` column is a §6.1 `VisibilityPolicy` enum string governing the
 * corresponding data: presence (§6.4), profile extras / bio (§6.2), and group
 * membership listing (§6.5). `allow_list` / `deny_list` are JSON arrays of
 * actors (`handle@domain`) that override the policy per §6.1 (deny wins, then
 * allow, then the policy).
 *
 * A row is created/updated lazily on `PUT /api/me/privacy`. When no row exists
 * the provider serves documented defaults (presence `sharedGroups`, profile
 * `public`, membership `authenticated`) — see `provider/privacy.ts`.
 */
export const privacySettings = sqliteTable("privacy_settings", {
  /** The LOCAL user handle these settings belong to. Primary key. */
  handle: text("handle").primaryKey(),
  /** Presence visibility (§6.4) — a `VisibilityPolicy` enum string. */
  presenceVisibility: text("presence_visibility").notNull(),
  /** Profile-extras (bio) visibility (§6.2) — a `VisibilityPolicy` enum string. */
  profileVisibility: text("profile_visibility").notNull(),
  /** Membership-listing visibility (§6.5) — a `VisibilityPolicy` enum string. */
  membershipVisibility: text("membership_visibility").notNull(),
  /** Override allow-list of actors, stored as a JSON `string[]`. */
  allowList: text("allow_list").notNull(),
  /** Override deny-list of actors, stored as a JSON `string[]`. */
  denyList: text("deny_list").notNull(),
  /** Last-update time (epoch millis). */
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type PrivacySettingsRow = typeof privacySettings.$inferSelect;
export type NewPrivacySettingsRow = typeof privacySettings.$inferInsert;

/**
 * Presence (spec §6.4, §7.5). One row per LOCAL user `handle`, holding the
 * user's **explicit** presence — the value they last set via `presence.set` /
 * `PUT /api/me/presence`. `offline` is NEVER stored here: it is the
 * *connection-derived* effective state computed at read time (a user with no
 * live WS connection is effectively `offline`, regardless of this stored value).
 *
 * `availability` is therefore one of `online | away | dnd` only (default
 * `online`). An explicit `away`/`dnd` + `status` persist across reconnects until
 * the user changes them (a successful `authenticate` does NOT clobber an
 * explicit away/dnd). `last_seen` is stamped when the user's LAST live
 * connection drops, and surfaced (filtered) on the effective presence.
 *
 * A row is created/updated lazily on the first `presence.set` /
 * `PUT /api/me/presence`. When no row exists the user's explicit availability is
 * the default `online` (so a connected user with no row reads as effectively
 * `online`).
 */
export const presence = sqliteTable("presence", {
  /** The LOCAL user handle this presence belongs to. Primary key. */
  handle: text("handle").primaryKey(),
  /** Explicit availability the user set: `online` | `away` | `dnd`. Never `offline`. */
  availability: text("availability").notNull().default("online"),
  /** Optional free-text status line (e.g. "On vacation"). */
  status: text("status"),
  /** Last time the user's last live connection dropped (epoch millis); nullable. */
  lastSeen: integer("last_seen", { mode: "number" }),
  /** Last-update time (epoch millis). */
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type PresenceRow = typeof presence.$inferSelect;
export type NewPresenceRow = typeof presence.$inferInsert;
