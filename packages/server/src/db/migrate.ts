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
