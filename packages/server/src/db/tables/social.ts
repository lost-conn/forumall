/**
 * Drizzle tables — Social graph + privacy: contacts, privacy settings, presence and follows (§6).
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Contacts (spec §6.7). A mutually-consented relationship that backs the
 * `contacts` visibility tier (§6.1). One row per (owner, user) FROM the local
 * `owner`'s perspective:
 *
 *  - `owner` is the LOCAL handle whose side of the relationship this row holds.
 *  - `user` is the OTHER actor (`handle@domain`), local or remote.
 *  - `state` is `pending` | `accepted`.
 *  - `direction` is `outgoing` (owner sent the request) | `incoming` (owner
 *    received it); meaningful only while `pending`, retained (but ignored) once
 *    `accepted`.
 *
 * A relationship is `accepted` for the `contacts` tier only once BOTH sides hold
 * an `accepted` row. For a fully-local pair that is both local rows; across
 * providers each provider independently converges its own row via the
 * federation receiver (`POST /api/federation/contacts`). This provider trusts
 * its OWN accepted row when answering the tier (`areContacts`), since that row
 * only reaches `accepted` after the mutual handshake.
 */
export const contacts = sqliteTable(
  "contacts",
  {
    /** The LOCAL handle whose perspective this row holds. */
    owner: text("owner").notNull(),
    /** The other actor (`handle@domain`), local or remote. */
    user: text("user").notNull(),
    /** Relationship state: `pending` | `accepted`. */
    state: text("state").notNull(),
    /** `outgoing` | `incoming`; meaningful while `pending`. */
    direction: text("direction").notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Last-update time (epoch millis); rendered as RFC 3339 `updatedAt`. */
    updatedAt: integer("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.owner, t.user] }),
    // Listing an owner's contacts (`GET /api/me/contacts`).
    ownerIdx: index("idx_contacts_owner").on(t.owner),
  }),
);

export type ContactRow = typeof contacts.$inferSelect;
export type NewContactRow = typeof contacts.$inferInsert;

/**
 * Per-user privacy settings (spec §6.6). One row per LOCAL user `handle`. Each
 * `*_visibility` column is a §6.1 `VisibilityPolicy` enum string governing the
 * corresponding data: presence (§6.4), profile extras / bio (§6.2), and group
 * membership listing (§6.5). `allow_list` / `deny_list` are JSON arrays of
 * actors (`handle@domain`) that override the policy per §6.1 (deny wins, then
 * allow, then the policy).
 *
 * A row is created/updated lazily on `PUT /api/me/privacy`. When no row exists
 * the provider serves documented defaults (presence `sharedGroups`, profile
 * `public`, membership `authenticated`) — see `provider/privacy.ts`.
 */
export const privacySettings = sqliteTable("privacy_settings", {
  /** The LOCAL user handle these settings belong to. Primary key. */
  handle: text("handle").primaryKey(),
  /** Presence visibility (§6.4) — a `VisibilityPolicy` enum string. */
  presenceVisibility: text("presence_visibility").notNull(),
  /** Profile-extras (bio) visibility (§6.2) — a `VisibilityPolicy` enum string. */
  profileVisibility: text("profile_visibility").notNull(),
  /** Membership-listing visibility (§6.5) — a `VisibilityPolicy` enum string. */
  membershipVisibility: text("membership_visibility").notNull(),
  /** Override allow-list of actors, stored as a JSON `string[]`. */
  allowList: text("allow_list").notNull(),
  /** Override deny-list of actors, stored as a JSON `string[]`. */
  denyList: text("deny_list").notNull(),
  /** Last-update time (epoch millis). */
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type PrivacySettingsRow = typeof privacySettings.$inferSelect;
export type NewPrivacySettingsRow = typeof privacySettings.$inferInsert;

/**
 * Presence (spec §6.4, §7.5). One row per LOCAL user `handle`, holding the
 * user's **explicit** presence — the value they last set via `presence.set` /
 * `PUT /api/me/presence`. `offline` is NEVER stored here: it is the
 * *connection-derived* effective state computed at read time (a user with no
 * live WS connection is effectively `offline`, regardless of this stored value).
 *
 * `availability` is therefore one of `online | away | dnd` only (default
 * `online`). An explicit `away`/`dnd` + `status` persist across reconnects until
 * the user changes them (a successful `authenticate` does NOT clobber an
 * explicit away/dnd). `last_seen` is stamped when the user's LAST live
 * connection drops, and surfaced (filtered) on the effective presence.
 *
 * A row is created/updated lazily on the first `presence.set` /
 * `PUT /api/me/presence`. When no row exists the user's explicit availability is
 * the default `online` (so a connected user with no row reads as effectively
 * `online`).
 */
export const presence = sqliteTable("presence", {
  /** The LOCAL user handle this presence belongs to. Primary key. */
  handle: text("handle").primaryKey(),
  /** Explicit availability the user set: `online` | `away` | `dnd`. Never `offline`. */
  availability: text("availability").notNull().default("online"),
  /** Optional free-text status line (e.g. "On vacation"). */
  status: text("status"),
  /** Last time the user's last live connection dropped (epoch millis); nullable. */
  lastSeen: integer("last_seen", { mode: "number" }),
  /** Last-update time (epoch millis). */
  updatedAt: integer("updated_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type PresenceRow = typeof presence.$inferSelect;
export type NewPresenceRow = typeof presence.$inferInsert;

/**
 * Follows (spec §7.6). A follow is a **pointer** — the provider stores only
 * *which* channels a local user follows; it does NOT compile or store a feed
 * (the client composes the home feed by reading each followed channel from its
 * authoritative source, §7.6). One row per (owner, channel).
 *
 *  - `owner` is the LOCAL handle who follows.
 *  - `channel` is the channel reference (§2.4): a bare local `chn_…` id, or a
 *    URI for a remote channel (or the canonical local channel URI).
 *  - `group_id` is the optional owning-group ref the client supplied.
 *  - `metadata` is a JSON `MetadataList`.
 *
 * There is intentionally NO feed table: the only follow state is this pointer.
 */
export const follows = sqliteTable(
  "follows",
  {
    /** The LOCAL handle who follows. */
    owner: text("owner").notNull(),
    /** Followed channel ref (§2.4): local `chn_…` id or a URI. */
    channel: text("channel").notNull(),
    /** Optional owning-group ref supplied with the follow; nullable. */
    groupId: text("group_id"),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Extension metadata list, stored as JSON (`MetadataList`). */
    metadata: text("metadata").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.owner, t.channel] }),
    // Listing an owner's follows (`GET /api/me/follows`).
    ownerIdx: index("idx_follows_owner").on(t.owner),
  }),
);

export type FollowRow = typeof follows.$inferSelect;
export type NewFollowRow = typeof follows.$inferInsert;
