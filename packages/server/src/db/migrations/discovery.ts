/**
 * Migrations for known providers and the discover allowlist. The run order is the
 * `migrations` list in `../migrate.ts`; never edit or rename a shipped one.
 */
import type { Migration } from "../migration-types.ts";

export const m0021KnownProviders: Migration = {
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
};

export const m0033DiscoverFeatures: Migration = {
  // Admin-curated discover allowlist (Forumall extension, not OFSCP). One row
  // per GROUP the provider admin has explicitly featured in the discovery feed
  // (§11.2). The discover compile query intersects this allowlist with the
  // existing `tier='discoverable'` channel filter, so a discoverable channel is
  // only surfaced if its owning group is featured. The UNIQUE `group_id` index
  // makes featuring idempotent (upsert). Create-if-not-exists DDL; guarded for
  // re-run.
  id: "0033_discover_features",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS discover_features (
        id         TEXT PRIMARY KEY,
        group_id   TEXT NOT NULL,
        added_by   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_discover_features_group ON discover_features (group_id);",
    );
  },
};
