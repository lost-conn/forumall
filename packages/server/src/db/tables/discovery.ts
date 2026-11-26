/**
 * Drizzle tables — Provider discovery extensions: known providers and the admin-curated discover allowlist (§11).
 */
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Known providers / peers (spec §8.6, OPTIONAL). A flat list of peer provider
 * domains this provider has recorded, used to support discovery (§11.2) without
 * a central registry. The list is grown by manual seeding and/or scraping peers'
 * `GET /api/providers` (`provider/known-providers.ts`).
 *
 *  - `domain` is the canonicalized peer authority (e.g. `b.test`) and the
 *    primary key, so re-adding a peer is idempotent (an upsert).
 *  - `name` is an optional human label.
 *  - `added_at` is when this peer was first recorded.
 *
 * This is the ONLY table backing §8.6; the discovery feed (§11.2) stores nothing
 * — its items are pointers compiled at read time (`provider/discover.ts`).
 */
export const knownProviders = sqliteTable("known_providers", {
  /** Canonicalized peer authority (e.g. `b.test`). Primary key (idempotent add). */
  domain: text("domain").primaryKey(),
  /** Optional human label for the peer. */
  name: text("name"),
  /** First-recorded time (epoch millis); rendered as RFC 3339 `addedAt`. */
  addedAt: integer("added_at", { mode: "number" })
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type KnownProviderRow = typeof knownProviders.$inferSelect;
export type NewKnownProviderRow = typeof knownProviders.$inferInsert;

/**
 * Admin-curated discover allowlist (Forumall extension, not OFSCP). One row per
 * GROUP the provider admin has explicitly featured in the discovery feed
 * (§11.2). The discover compile query (`provider/discover.ts`) intersects this
 * allowlist with the channel-level `tier='discoverable'` filter, so a
 * discoverable channel only surfaces when its owning group is featured. With no
 * featured groups the feed is empty (not an error).
 *
 *  - `group_id` is the featured `grp_…` id; UNIQUE, so featuring is idempotent.
 *  - `added_by` is the admin handle that featured it (audit only).
 */
export const discoverFeatures = sqliteTable(
  "discover_features",
  {
    /** Stable id, e.g. `dsf_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** Featured group id (`grp_…`). UNIQUE — idempotent feature. */
    groupId: text("group_id").notNull(),
    /** Admin handle that featured the group (audit only). */
    addedBy: text("added_by").notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 when needed. */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    // At most one feature row per group (idempotent feature/upsert).
    groupIdx: uniqueIndex("idx_discover_features_group").on(t.groupId),
  }),
);

export type DiscoverFeatureRow = typeof discoverFeatures.$inferSelect;
export type NewDiscoverFeatureRow = typeof discoverFeatures.$inferInsert;
