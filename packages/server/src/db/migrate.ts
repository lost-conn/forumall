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
