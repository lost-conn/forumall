/**
 * Migrations for groups, members, channels, join requests, invites, channel permissions and roles. The run order is the
 * `migrations` list in `../migrate.ts`; never edit or rename a shipped one.
 */
import { sha256 } from "@noble/hashes/sha2";

import type { Migration } from "../migration-types.ts";

export const m0005GroupsAndMembers: Migration = {
  id: "0005_groups_and_members",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        owner       TEXT NOT NULL,
        join_policy TEXT NOT NULL,
        tier        TEXT NOT NULL,
        permissions TEXT NOT NULL,
        metadata    TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id  TEXT NOT NULL,
        user      TEXT NOT NULL,
        role      TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user)
      ) STRICT;
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user);");
  },
};

export const m0006Channels: Migration = {
  id: "0006_channels",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id         TEXT PRIMARY KEY,
        group_id   TEXT NOT NULL,
        name       TEXT,
        type       TEXT NOT NULL,
        tier       TEXT NOT NULL,
        topic      TEXT,
        tags       TEXT NOT NULL,
        metadata   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_channels_group_id ON channels (group_id);");
  },
};

export const m0007JoinRequests: Migration = {
  id: "0007_join_requests",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS join_requests (
        id           TEXT PRIMARY KEY,
        group_id     TEXT NOT NULL,
        user         TEXT NOT NULL,
        state        TEXT NOT NULL,
        message      TEXT,
        requested_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_join_requests_group_id ON join_requests (group_id);",
    );
  },
};

export const m0009Invites: Migration = {
  id: "0009_invites",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        id           TEXT PRIMARY KEY,
        group_id     TEXT NOT NULL,
        token        TEXT NOT NULL UNIQUE,
        channel_id   TEXT,
        role         TEXT NOT NULL DEFAULT 'member',
        grants_guest INTEGER NOT NULL DEFAULT 0,
        max_uses     INTEGER,
        uses         INTEGER NOT NULL DEFAULT 0,
        expires_at   INTEGER,
        created_by   TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_invites_token ON invites (token);");
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_invites_group_id ON invites (group_id);");
  },
};

export const m0022ChannelPermissions: Migration = {
  // Per-channel permission overrides (§5.2.1). Nullable JSON column holding a
  // `ChannelPermissions` object; null/absent means the channel inherits the
  // group's permissions and tier. ADD COLUMN is safe on a STRICT table because
  // the column is nullable with no default.
  id: "0022_channel_permissions",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(channels)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("permissions")) {
      sqlite.exec("ALTER TABLE channels ADD COLUMN permissions TEXT;");
    }
  },
};

export const m0024GroupRoles: Migration = {
  // Custom role catalogue (§5.2): a per-group `roles` JSON list backing custom
  // roles. ADD COLUMN with a default, then backfill existing groups with the
  // canonical catalogue so their member dropdowns offer roles to assign.
  id: "0024_group_roles",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(groups)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("roles")) {
      sqlite.exec("ALTER TABLE groups ADD COLUMN roles TEXT NOT NULL DEFAULT '[]';");
      sqlite.exec(
        `UPDATE groups SET roles = '[{"name":"admin","color":"#9837be"},{"name":"member","color":"#37a8be"},{"name":"guest","color":"#8a8f98"}]' WHERE roles = '[]';`,
      );
    }
  },
};

export const m0025GroupMembersDisplayNameOverride: Migration = {
  // Per-group display name (Overboard "Per-group display name"): a nullable
  // `display_name_override` on `group_members`. When set it overrides the
  // member's GLOBAL `UserProfile.displayName` within THIS group only
  // (Discord-server-nickname style); NULL/absent → use the global name.
  // ADD COLUMN is safe on a STRICT table because the column is nullable with
  // no default. Guarded so a re-run is a no-op.
  id: "0025_group_members_display_name_override",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(group_members)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("display_name_override")) {
      sqlite.exec("ALTER TABLE group_members ADD COLUMN display_name_override TEXT;");
    }
  },
};

export const m0027GroupsAvatar: Migration = {
  // Group avatars (Overboard "Group avatars"): a nullable `avatar` image URL
  // on `groups`, mirroring the per-user `users.avatar` column. Set via the
  // existing PATCH /api/groups/{id} (no new endpoint); the image is uploaded
  // through POST /api/media and the returned https url stored here.
  // ADD COLUMN is safe on a STRICT table because the column is nullable with
  // no default. Guarded so a re-run is a no-op.
  id: "0027_groups_avatar",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(groups)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("avatar")) {
      sqlite.exec("ALTER TABLE groups ADD COLUMN avatar TEXT;");
    }
  },
};

export const m0043InvitesTokenDigest: Migration = {
  // Invite tokens are bearer secrets (§5.6): store only a SHA-256 digest so a
  // database leak does not reveal them. `token` becomes `token_digest`
  // (lowercase hex SHA-256 of the token's UTF-8 bytes, the encoding of
  // `inviteTokenDigest` in `provider/invites.ts`).
  //
  // Existing invites are CONVERTED, not invalidated: each stored plaintext
  // token is digested, so join links already shared keep working, and the
  // plaintext is gone once the old table is dropped. SQLite cannot drop a
  // UNIQUE column in place, so the table is rebuilt (create new → copy → drop
  // → rename) inside the migration's transaction and the group index
  // re-created; the UNIQUE constraint indexes `token_digest` lookups.
  // Nothing references `invites` through a foreign-key constraint.
  id: "0043_invites_token_digest",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE invites_new (
        id           TEXT PRIMARY KEY,
        group_id     TEXT NOT NULL,
        token_digest TEXT NOT NULL UNIQUE,
        channel_id   TEXT,
        role         TEXT NOT NULL DEFAULT 'member',
        grants_guest INTEGER NOT NULL DEFAULT 0,
        max_uses     INTEGER,
        uses         INTEGER NOT NULL DEFAULT 0,
        expires_at   INTEGER,
        created_by   TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      ) STRICT;
    `);
    const insert = sqlite.prepare(
      `INSERT INTO invites_new (id, group_id, token_digest, channel_id, role, grants_guest,
         max_uses, uses, expires_at, created_by, created_at)
       SELECT id, group_id, ?, channel_id, role, grants_guest,
         max_uses, uses, expires_at, created_by, created_at
       FROM invites WHERE id = ?`,
    );
    const rows = sqlite
      .query<{ id: string; token: string }, []>("SELECT id, token FROM invites")
      .all();
    for (const row of rows) {
      const digest = Buffer.from(sha256(new TextEncoder().encode(row.token))).toString("hex");
      insert.run(digest, row.id);
    }
    sqlite.exec("DROP TABLE invites;");
    sqlite.exec("ALTER TABLE invites_new RENAME TO invites;");
    sqlite.exec("CREATE INDEX idx_invites_group_id ON invites (group_id);");
  },
};
