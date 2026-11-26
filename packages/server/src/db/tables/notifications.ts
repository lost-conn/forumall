/**
 * Drizzle tables — Notifications: webhook endpoints (§10), the inbound feed, Web Push and per-scope preferences.
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Notification webhook endpoints (spec §10). One row per registered webhook: a
 * local user (`owner`) asks this provider to deliver a provider-signed webhook
 * to `target` whenever one of the subscribed `events` (e.g. `message.created`,
 * `call.started`) fires for a resource the owner can see.
 *
 *  - `owner` is the LOCAL handle that registered the endpoint.
 *  - `type` is the transport hint (e.g. `webpush`) — open string, passthrough.
 *  - `target` is the HTTPS URL the provider POSTs the (provider-signed) delivery
 *    to.
 *  - `events` is a JSON `string[]` of subscribed event names.
 *
 * Delivery itself (§10) signs the HTTP request with this provider's signing key
 * (§8.1) AND carries a detached Ed25519 `signature` in the body over the
 * canonical delivery payload, so a stored payload stays verifiable independent of
 * transport. The owner index backs both per-owner listing and the membership-
 * scoped fan-out lookup.
 */
export const notificationEndpoints = sqliteTable(
  "notification_endpoints",
  {
    /** Stable endpoint id, e.g. `nep_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** The LOCAL handle that registered this endpoint. */
    owner: text("owner").notNull(),
    /** Transport hint (e.g. `webpush`); open string. */
    type: text("type").notNull(),
    /** HTTPS delivery URL the provider-signed webhook is POSTed to. */
    target: text("target").notNull(),
    /** Subscribed event names, stored as a JSON `string[]`. */
    events: text("events").notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    ownerIdx: index("idx_notification_endpoints_owner").on(t.owner),
  }),
);

export type NotificationEndpointRow = typeof notificationEndpoints.$inferSelect;
export type NewNotificationEndpointRow = typeof notificationEndpoints.$inferInsert;

/**
 * Inbound notifications feed (a provider-LOCAL extension — distinct from the §10
 * outbound notification webhooks). One row per (local recipient, triggering
 * message) for an @mention in, or a reply to, a group CHANNEL. State is two
 * independent nullable timestamps: `seenAt` (appeared in the inbox list) and
 * `readAt` (acted on). Keyed on the LOCAL `recipient` handle and never federated.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    /** Stable notification id (`ntf_<base64url>`). Primary key. */
    id: text("id").primaryKey(),
    /** The LOCAL user handle this notification belongs to. */
    recipient: text("recipient").notNull(),
    /** `mention` | `reply`. */
    type: text("type").notNull(),
    /** The message that triggered this notification (`msg_…`). */
    sourceMessageId: text("source_message_id").notNull(),
    /** Channel the source message is in (`chn_…`). */
    channelId: text("channel_id").notNull(),
    /** Group the channel belongs to (`grp_…`). */
    groupId: text("group_id").notNull(),
    /** Author of the source message (`handle@domain`). */
    author: text("author").notNull(),
    /** Creation time (epoch millis). */
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    /** When this appeared in the inbox list (epoch millis); null until seen. */
    seenAt: integer("seen_at", { mode: "number" }),
    /** When the user acted on it (epoch millis); null until read. */
    readAt: integer("read_at", { mode: "number" }),
  },
  (t) => ({
    // Newest-first feed paging per recipient (createdAt DESC, id tiebreak).
    recipientCreatedIdx: index("idx_notifications_recipient_created").on(t.recipient, t.createdAt),
    // Unseen/unread count scans per recipient.
    recipientSeenIdx: index("idx_notifications_recipient_seen").on(t.recipient, t.seenAt),
    // Dedupe guard: at most one row per (recipient, type, sourceMessageId).
    dedupeIdx: uniqueIndex("idx_notifications_recipient_type_source").on(
      t.recipient,
      t.type,
      t.sourceMessageId,
    ),
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;

/**
 * The provider's own VAPID (Web Push application-server) P-256 key pair (RFC
 * 8292) — distinct from the Ed25519 `provider_keys` signing identity. Generated
 * once on first push use and reused across restarts (mirrors `provider_keys`).
 * The public half is the `applicationServerKey` browsers subscribe with; the
 * private scalar signs the per-request VAPID JWT and is NEVER served.
 */
export const pushKeys = sqliteTable("push_keys", {
  /** Stable id, e.g. `vpk-<short>`. Primary key. */
  keyId: text("key_id").primaryKey(),
  /** Base64url raw uncompressed P-256 public key (65 bytes, `0x04||X||Y`). */
  publicKey: text("public_key").notNull(),
  /** Base64url raw 32-byte P-256 private scalar. Secret; never served. */
  privateKey: text("private_key").notNull(),
  /** Always `P-256` in v0.1; column exists to support future algorithms. */
  algorithm: text("algorithm").notNull(),
  /** Creation time (epoch millis). */
  createdAt: integer("created_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type PushKeyRow = typeof pushKeys.$inferSelect;
export type NewPushKeyRow = typeof pushKeys.$inferInsert;

/**
 * Web Push subscriptions (provider-local extension). One row per registered
 * browser `PushSubscription` for a LOCAL recipient. The unique `endpoint` index
 * makes (re-)subscribing idempotent; a `410 Gone`/`404` from the push service
 * deletes the row (dead subscription cleanup). Keyed on the LOCAL `recipient`
 * handle and never federated.
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    /** Stable id (`psh_<base64url>`). Primary key. */
    id: text("id").primaryKey(),
    /** The LOCAL user handle this subscription belongs to. */
    recipient: text("recipient").notNull(),
    /** The push service endpoint URL (unique — idempotent re-subscribe). */
    endpoint: text("endpoint").notNull(),
    /** The subscription's P-256 public key (`p256dh`), base64url. */
    p256dh: text("p256dh").notNull(),
    /** The subscription's auth secret (`auth`), base64url. */
    auth: text("auth").notNull(),
    /** Creation time (epoch millis). */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Last successful delivery time (epoch millis); null until first delivery. */
    lastDeliveredAt: integer("last_delivered_at", { mode: "number" }),
  },
  (t) => ({
    // Idempotent (re-)subscribe: at most one row per push endpoint.
    endpointIdx: uniqueIndex("idx_push_subscriptions_endpoint").on(t.endpoint),
    // Fan-out scan: all of a recipient's subscriptions.
    recipientIdx: index("idx_push_subscriptions_recipient").on(t.recipient),
  }),
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;

/**
 * Per-channel / per-group notification preferences (provider-local extension).
 * One row per (`owner`, `scopeType`, `scopeId`) holding the recipient's chosen
 * notification `mode` for that scope:
 *
 *  - `all`      — notify on EVERY message in the scope.
 *  - `mentions` — notify only on @mention / reply (the default behavior).
 *  - `none`     — muted; notify on nothing.
 *
 * A scope is either a `group` (`scopeId` = `grp_…`) or a `channel`
 * (`scopeId` = `chn_…`). A MISSING row means "inherit": the effective mode for a
 * (recipient, channel) resolves channel pref → group pref → default `mentions`
 * (`provider/notification-prefs.ts`). Keyed on the LOCAL `owner` handle and never
 * federated — this is private, per-account state synced across the owner's own
 * devices. The unique (owner, scopeType, scopeId) index makes the upsert
 * idempotent; the owner index backs per-owner listing + the `all`-fan-out scan.
 */
export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    /** Stable id (`npf_<base64url>`). Primary key. */
    id: text("id").primaryKey(),
    /** The LOCAL user handle this preference belongs to. */
    owner: text("owner").notNull(),
    /** Scope kind: `group` | `channel`. */
    scopeType: text("scope_type").notNull(),
    /** The scoped id: a `grp_…` (group) or `chn_…` (channel) id. */
    scopeId: text("scope_id").notNull(),
    /** Notification mode: `all` | `mentions` | `none`. */
    mode: text("mode").notNull(),
    /** Last-update time (epoch millis). */
    updatedAt: integer("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    // Upsert axis: at most one preference per (owner, scopeType, scopeId).
    ownerScopeIdx: uniqueIndex("idx_notification_preferences_owner_scope").on(
      t.owner,
      t.scopeType,
      t.scopeId,
    ),
    // Per-owner listing + the `all`-fan-out membership scan.
    ownerIdx: index("idx_notification_preferences_owner").on(t.owner),
  }),
);

export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreferenceRow = typeof notificationPreferences.$inferInsert;
