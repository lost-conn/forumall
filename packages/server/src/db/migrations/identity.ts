/**
 * Migrations for provider metadata/keys, users, bootstrap tokens, device keys, profile + admin columns. The run order is the
 * `migrations` list in `../migrate.ts`; never edit or rename a shipped one.
 */
import type { Migration } from "../migration-types.ts";

export const m0001AppMeta: Migration = {
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
};

export const m0002ProviderKeys: Migration = {
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
};

export const m0003UsersAndBootstrapTokens: Migration = {
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
};

export const m0004DeviceKeys: Migration = {
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
};

export const m0008UsersGuestColumns: Migration = {
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
};

export const m0016UsersProfileColumns: Migration = {
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
};

export const m0032ProviderAdmin: Migration = {
  // Provider admin (Forumall extension, not OFSCP): a nullable-free `is_admin`
  // integer-boolean on `users`, mirroring the `guest` column style. Set on the
  // first registration (instance owner) and for `config.adminHandles`. ADD
  // COLUMN with a default is safe on a STRICT table; guarded so a re-run is a
  // no-op.
  id: "0032_provider_admin",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(users)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("is_admin")) {
      sqlite.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;");
    }
  },
};
