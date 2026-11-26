/**
 * Migrations for notification endpoints, the inbound feed, Web Push and preferences. The run order is the
 * `migrations` list in `../migrate.ts`; never edit or rename a shipped one.
 */
import type { Migration } from "../migration-types.ts";

export const m0020NotificationEndpoints: Migration = {
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
};

export const m0029Notifications: Migration = {
  // Inbound notifications feed (provider-local) — @mentions + thread-replies on
  // a group CHANNEL, one row per (local recipient, triggering message). Two
  // independent nullable timestamps (`seen_at`, `read_at`). The unique
  // (recipient, type, source_message_id) index dedupes; the recipient indexes
  // back the newest-first feed + the unseen counts. Distinct from the §10
  // outbound webhook `notification_endpoints` table. Guarded for re-run.
  id: "0029_notifications",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id                TEXT PRIMARY KEY,
        recipient         TEXT NOT NULL,
        type              TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        channel_id        TEXT NOT NULL,
        group_id          TEXT NOT NULL,
        author            TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        seen_at           INTEGER,
        read_at           INTEGER
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications (recipient, created_at);",
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_notifications_recipient_seen ON notifications (recipient, seen_at);",
    );
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_recipient_type_source ON notifications (recipient, type, source_message_id);",
    );
  },
};

export const m0030Push: Migration = {
  // Web Push (provider-local): the provider's own VAPID P-256 key pair
  // (generate-once, mirrors `provider_keys`) + per-recipient browser push
  // subscriptions. The unique `endpoint` index makes re-subscribe idempotent
  // and backs the 410-cleanup delete; the recipient index backs fan-out.
  // Guarded for re-run.
  id: "0030_push",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS push_keys (
        key_id      TEXT PRIMARY KEY,
        public_key  TEXT NOT NULL,
        private_key TEXT NOT NULL,
        algorithm   TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id                TEXT PRIMARY KEY,
        recipient         TEXT NOT NULL,
        endpoint          TEXT NOT NULL,
        p256dh            TEXT NOT NULL,
        auth              TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        last_delivered_at INTEGER
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);",
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_recipient ON push_subscriptions (recipient);",
    );
  },
};

export const m0031NotificationPreferences: Migration = {
  // Per-channel / per-group notification preferences (provider-local). One row
  // per (owner, scope_type, scope_id) holding the recipient's chosen mode
  // (`all` | `mentions` | `none`). A missing row means "inherit": the effective
  // mode resolves channel pref → group pref → default `mentions`. The unique
  // (owner, scope_type, scope_id) index makes the upsert idempotent; the owner
  // index backs the per-owner listing + the `all`-fan-out membership scan.
  // Guarded for re-run.
  id: "0031_notification_preferences",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id         TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id   TEXT NOT NULL,
        mode       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_owner_scope ON notification_preferences (owner, scope_type, scope_id);",
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_notification_preferences_owner ON notification_preferences (owner);",
    );
  },
};
