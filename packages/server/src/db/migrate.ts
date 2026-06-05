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
