/**
 * Migrations for contacts, privacy settings, presence and follows. The run order is the
 * `migrations` list in `../migrate.ts`; never edit or rename a shipped one.
 */
import type { Migration } from "../migration-types.ts";

export const m0015Contacts: Migration = {
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
};

export const m0017PrivacySettings: Migration = {
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
};

export const m0018Presence: Migration = {
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
};

export const m0019Follows: Migration = {
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
};

export const m0043FollowsDropGroupId: Migration = {
  // §7.6: a `Follow`'s `groupId` MUST be derived from the channel and a body
  // `groupId` ignored. The column held the client-supplied value, so it goes;
  // `provider/follows.ts` derives the group whenever a follow is rendered.
  id: "0043_follows_drop_group_id",
  up: (sqlite) => {
    sqlite.exec("ALTER TABLE follows DROP COLUMN group_id;");
  },
};
