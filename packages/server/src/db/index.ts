/**
 * Database handle: open a `bun:sqlite` Database at the configured path and wrap
 * it with Drizzle.
 *
 * Self-host friendly: a single file, no DB server. The parent directory is
 * created if missing, and `:memory:` is honored for ephemeral test databases.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema.ts";

export type DB = ReturnType<typeof drizzle<typeof schema>>;

/** A drizzle handle plus its underlying sqlite connection (for migrate/close). */
export interface Db {
  readonly drizzle: DB;
  readonly sqlite: Database;
}

/**
 * Open the database at `dbPath` and return a Drizzle handle. Pass `:memory:`
 * for an in-memory database (no directory is created in that case).
 */
export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath, { create: true });
  // Pragmas tuned for a single-process self-hosted provider.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  return {
    sqlite,
    drizzle: drizzle(sqlite, { schema }),
  };
}
