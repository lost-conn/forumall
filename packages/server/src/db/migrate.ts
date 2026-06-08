/**
 * Schema migrations, applied idempotently on boot.
 *
 * ## Approach
 * Rather than depend on drizzle-kit's generated SQL + journal (which adds a
 * build step and ships extra files), the skeleton uses a small, explicit,
 * forward-only migration list. Each migration has a unique `id` and runs inside
 * a transaction; applied ids are recorded in a `_migrations` ledger table, so
 * running {@link migrate} any number of times is a no-op after the first.
 *
 * This is deliberately simple and self-host-friendly: migrations run on startup
 * with no separate command, and the SQL is plain create-if-not-exists DDL.
 * Later cards append a new entry to {@link migrations} (never edit a shipped
 * one) when they introduce tables.
 */
import type { Database } from "bun:sqlite";

import type { Db } from "./index.ts";

interface Migration {
  /** Stable, unique identifier; ledgered once applied. Never reuse/rename. */
  readonly id: string;
  /** Idempotent-friendly DDL. Runs inside a transaction. */
  readonly up: (sqlite: Database) => void;
}

/**
 * Ordered, forward-only migration list. Append new migrations; do not edit or
 * reorder existing ones once shipped.
 */
const migrations: readonly Migration[] = [
  {
    id: "0001_app_meta",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    id: "0002_provider_keys",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS provider_keys (
          key_id      TEXT PRIMARY KEY,
          public_key  TEXT NOT NULL,
          private_key TEXT NOT NULL,
          algorithm   TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    id: "0003_users_and_bootstrap_tokens",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS users (
          handle         TEXT PRIMARY KEY,
          password_hash  TEXT NOT NULL,
          recovery_email TEXT,
          created_at     INTEGER NOT NULL
        ) STRICT;
      `);
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS bootstrap_tokens (
          token_hash TEXT PRIMARY KEY,
          handle     TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          used_at    INTEGER
        ) STRICT;
      `);
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_bootstrap_tokens_handle ON bootstrap_tokens (handle);",
      );
    },
  },
  {
    id: "0004_device_keys",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS device_keys (
          key_id      TEXT PRIMARY KEY,
          user_handle TEXT NOT NULL,
          public_key  TEXT NOT NULL,
          algorithm   TEXT NOT NULL,
          device_name TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          revoked     INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `);
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_device_keys_user_handle ON device_keys (user_handle);",
      );
    },
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    // Guest accounts (§4.8): make `password_hash` nullable and add the
    // `guest` / `display_name` / `expires_at` columns to `users`.
    //
    // SQLite cannot ALTER a NOT NULL constraint off an existing column, so we
    // rebuild the table (create new → copy → drop → rename) inside the
    // migration's transaction. The DB is greenfield, but the copy preserves any
    // rows that exist (full accounts default to guest=0, the others NULL). The
    // table-rebuild recipe disables foreign-key enforcement; `users` has no FKs
    // pointing at it via SQLite constraints (references are by `handle` string),
    // so a plain rebuild is safe.
    id: "0008_users_guest_columns",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE users_new (
          handle         TEXT PRIMARY KEY,
          password_hash  TEXT,
          recovery_email TEXT,
          guest          INTEGER NOT NULL DEFAULT 0,
          display_name   TEXT,
          expires_at     INTEGER,
          created_at     INTEGER NOT NULL
        ) STRICT;
      `);
      sqlite.exec(`
        INSERT INTO users_new (handle, password_hash, recovery_email, guest, display_name, expires_at, created_at)
        SELECT handle, password_hash, recovery_email, 0, NULL, NULL, created_at
        FROM users;
      `);
      sqlite.exec("DROP TABLE users;");
      sqlite.exec("ALTER TABLE users_new RENAME TO users;");
    },
  },
  {
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
  },
  {
    // Messages (§5.3, §7.2). `seq` is the globally-monotonic timeline position
    // and basis of the §7.2 opaque cursor (shared with §7.1 WS resume). The
    // (channel_id, seq) index backs per-channel keyset paging; the unique seq
    // index keeps the cursor globally unambiguous.
    id: "0010_messages",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id                TEXT PRIMARY KEY,
          channel_id        TEXT NOT NULL,
          group_id          TEXT NOT NULL,
          author            TEXT NOT NULL,
          type              TEXT NOT NULL,
          content           TEXT NOT NULL,
          attachments       TEXT NOT NULL,
          reference         TEXT,
          tags              TEXT NOT NULL,
          seq               INTEGER NOT NULL,
          created_at        INTEGER NOT NULL,
          edited_at         INTEGER,
          deleted_at        INTEGER,
          edit_until        INTEGER NOT NULL,
          client_message_id TEXT
        ) STRICT;
      `);
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages (channel_id, seq);",
      );
      sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages (seq);");
    },
  },
  {
    // WS create idempotency (§7.1): `(author, channelId, clientMessageId)` is
    // idempotent. A PARTIAL unique index (only where client_message_id is not
    // null) enforces "at most one message per (author, channel, key)" while
    // still permitting unlimited rows that carry no idempotency key.
    id: "0011_messages_client_message_id_unique",
    up: (sqlite) => {
      sqlite.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_author_channel_client_msg
           ON messages (author, channel_id, client_message_id)
           WHERE client_message_id IS NOT NULL;`,
      );
    },
  },
  {
    // Reactions (§5.3, §7.1). At most one reaction per (message, author, key)
    // enforced by the unique index (idempotent add). The message_id index backs
    // the paginated listing endpoint. No server-aggregated count column —
    // clients aggregate from these rows / the reaction.* events.
    id: "0012_reactions",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS reactions (
          id         TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          group_id   TEXT NOT NULL,
          author     TEXT NOT NULL,
          key        TEXT NOT NULL,
          unicode    TEXT,
          image      TEXT,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      sqlite.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_message_author_key
           ON reactions (message_id, author, key);`,
      );
      sqlite.exec("CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions (message_id);");
    },
  },
  {
    // Media / attachments (§5.8). Metadata for uploaded blobs; the raw bytes
    // live in the storage backend (filesystem by default), keyed by `id`. The
    // owner index backs per-user media listings.
    id: "0013_media",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS media (
          id         TEXT PRIMARY KEY,
          mime       TEXT NOT NULL,
          size       INTEGER NOT NULL,
          filename   TEXT,
          hash       TEXT NOT NULL,
          width      INTEGER,
          height     INTEGER,
          owner      TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      sqlite.exec("CREATE INDEX IF NOT EXISTS idx_media_owner ON media (owner);");
    },
  },
  {
    // Direct messages (§7.4, §8.3). `dm_messages` is the recipient's inbox (no
    // sender copy); `seq` shares the global timeline space with `messages` so
    // the §7.2 cursor/`dm.message` cursor is one space. `dm_conversations` is the
    // per-inbox summary that backs listing AND participation checks. The
    // partial unique index enforces (owner, dm_id, author, client_message_id)
    // idempotency only for keyed rows.
    id: "0014_direct_messages",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS dm_messages (
          id                TEXT PRIMARY KEY,
          dm_id             TEXT NOT NULL,
          owner             TEXT NOT NULL,
          author            TEXT NOT NULL,
          content           TEXT NOT NULL,
          attachments       TEXT NOT NULL,
          reference         TEXT,
          seq               INTEGER NOT NULL,
          created_at        INTEGER NOT NULL,
          edited_at         INTEGER,
          deleted_at        INTEGER,
          edit_until        INTEGER NOT NULL,
          client_message_id TEXT
        ) STRICT;
      `);
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_dm_messages_owner_dm_seq ON dm_messages (owner, dm_id, seq);",
      );
      sqlite.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_messages_owner_dm_author_client_msg
           ON dm_messages (owner, dm_id, author, client_message_id)
           WHERE client_message_id IS NOT NULL;`,
      );
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS dm_conversations (
          owner             TEXT NOT NULL,
          dm_id             TEXT NOT NULL,
          counterparty      TEXT NOT NULL,
          updated_at        INTEGER NOT NULL,
          last_message_seq  INTEGER NOT NULL,
          PRIMARY KEY (owner, dm_id)
        ) STRICT;
      `);
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_dm_conversations_owner_updated ON dm_conversations (owner, updated_at);",
      );
    },
  },
  {
    // Contacts (§6.7). A mutually-consented relationship backing the `contacts`
    // visibility tier (§6.1). One row per (owner, user) from the local owner's
    // perspective; `direction` is meaningful while `state` is `pending`. The
    // owner index backs the contact listing (`GET /api/me/contacts`).
    id: "0015_contacts",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          owner      TEXT NOT NULL,
          user       TEXT NOT NULL,
          state      TEXT NOT NULL,
          direction  TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (owner, user)
        ) STRICT;
      `);
      sqlite.exec("CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts (owner);");
    },
  },
  {
    // Profile extras (§5.1, §6.2): add `avatar`, `bio`, `metadata`, and
    // `updated_at` to `users`. All nullable, so a plain ADD COLUMN suffices (no
    // table rebuild). `metadata` holds a JSON `MetadataList`; `updated_at` is the
    // profile-update timestamp surfaced as `UserProfile.updatedAt` once set
    // (otherwise the read path falls back to `created_at`).
    id: "0016_users_profile_columns",
    up: (sqlite) => {
      sqlite.exec("ALTER TABLE users ADD COLUMN avatar TEXT;");
      sqlite.exec("ALTER TABLE users ADD COLUMN bio TEXT;");
      sqlite.exec("ALTER TABLE users ADD COLUMN metadata TEXT;");
      sqlite.exec("ALTER TABLE users ADD COLUMN updated_at INTEGER;");
    },
  },
  {
    // Privacy settings (§6.6). One row per local user; each `*_visibility`
    // column is a §6.1 `VisibilityPolicy` enum string. `allow_list` / `deny_list`
    // are JSON arrays of actors. A missing row means "use the documented
    // defaults" (resolved in `provider/privacy.ts`), so rows are only written on
    // an explicit `PUT /api/me/privacy`.
    id: "0017_privacy_settings",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS privacy_settings (
          handle                TEXT PRIMARY KEY,
          presence_visibility   TEXT NOT NULL,
          profile_visibility    TEXT NOT NULL,
          membership_visibility TEXT NOT NULL,
          allow_list            TEXT NOT NULL,
          deny_list             TEXT NOT NULL,
          updated_at            INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    // Presence (§6.4, §7.5). One row per local user holding the EXPLICIT
    // presence the user last set (`online|away|dnd`, never `offline`). The
    // effective `offline` state is derived from WS connection liveness at read
    // time, not stored. `last_seen` is stamped when the user's last live
    // connection drops. A missing row means "explicitly online" (resolved in
    // `provider/presence.ts`), so rows are only written on an explicit set.
    id: "0018_presence",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS presence (
          handle       TEXT PRIMARY KEY,
          availability TEXT NOT NULL DEFAULT 'online',
          status       TEXT,
          last_seen    INTEGER,
          updated_at   INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    // Follows (§7.6). A follow is a POINTER only: one row per (owner, channel)
    // recording which channels a local user follows. The provider MUST NOT
    // compile or store a feed — there is intentionally no feed table here. The
    // owner index backs the follow listing (`GET /api/me/follows`).
    id: "0019_follows",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS follows (
          owner      TEXT NOT NULL,
          channel    TEXT NOT NULL,
          group_id   TEXT,
          created_at INTEGER NOT NULL,
          metadata   TEXT NOT NULL,
          PRIMARY KEY (owner, channel)
        ) STRICT;
      `);
      sqlite.exec("CREATE INDEX IF NOT EXISTS idx_follows_owner ON follows (owner);");
    },
  },
  {
    // Notification webhook endpoints (§10). One row per registered webhook: a
    // local owner asks this provider to deliver a provider-signed webhook to
    // `target` for each subscribed event. `events` is a JSON `string[]`. The
    // owner index backs per-owner listing and the membership-scoped fan-out.
    id: "0020_notification_endpoints",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS notification_endpoints (
          id         TEXT PRIMARY KEY,
          owner      TEXT NOT NULL,
          type       TEXT NOT NULL,
          target     TEXT NOT NULL,
          events     TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_notification_endpoints_owner ON notification_endpoints (owner);",
      );
    },
  },
  {
    // Known providers / peers (§8.6, OPTIONAL). A flat list of peer domains used
    // to support discovery (§11.2) without a central registry. `domain` is the
    // canonicalized peer authority and primary key, so re-adding is idempotent.
    // This is the only table for §8.6; the discovery feed (§11.2) stores nothing
    // (its items are compiled at read time).
    id: "0021_known_providers",
    up: (sqlite) => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS known_providers (
          domain   TEXT PRIMARY KEY,
          name     TEXT,
          added_at INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
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
  },
  {
    // Reply listing (§7.2): denormalize the reply parent id out of the
    // `reference` JSON into its own nullable column so it can be indexed +
    // queried directly. Backfill existing rows via json_extract, then index
    // (channel_id, reply_to, seq) for cursor-ordered reply pages.
    id: "0023_messages_reply_to",
    up: (sqlite) => {
      const cols = sqlite
        .query<{ name: string }, []>("PRAGMA table_info(messages)")
        .all()
        .map((c) => c.name);
      if (!cols.includes("reply_to")) {
        sqlite.exec("ALTER TABLE messages ADD COLUMN reply_to TEXT;");
        // Backfill: a reply has reference.type === "reply"; pull reference.id.
        sqlite.exec(`
          UPDATE messages
             SET reply_to = json_extract(reference, '$.id')
           WHERE reference IS NOT NULL
             AND json_valid(reference)
             AND json_extract(reference, '$.type') = 'reply';
        `);
      }
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_messages_channel_reply_to ON messages (channel_id, reply_to, seq);",
      );
    },
  },
  {
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
  },
];

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id         TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  ) STRICT;
`;

/**
 * Apply any not-yet-applied migrations. Idempotent: safe to call on every boot.
 * Returns the ids that were applied during this call (empty if up to date).
 */
export function migrate(db: Db): string[] {
  const { sqlite } = db;
  sqlite.exec(LEDGER_DDL);

  const appliedRows = sqlite.query<{ id: string }, []>("SELECT id FROM _migrations").all();
  const applied = new Set(appliedRows.map((r) => r.id));

  const record = sqlite.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)");

  const newlyApplied: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    // Each migration is atomic: DDL + ledger insert commit together.
    sqlite.transaction(() => {
      m.up(sqlite);
      record.run(m.id, Date.now());
    })();
    newlyApplied.push(m.id);
  }

  return newlyApplied;
}
