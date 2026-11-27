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
 * A new migration is defined with its domain in `migrations/*.ts` and appended
 * to {@link migrations} (never edit or reorder a shipped one).
 */
import { canonicalAuthority } from "@forumall/shared";

import type { Config } from "../config.ts";
import type { Db } from "./index.ts";
import type { Migration, MigrationContext } from "./migration-types.ts";
import { MigrationDeferred } from "./migration-types.ts";
import { m0021KnownProviders, m0033DiscoverFeatures } from "./migrations/discovery.ts";
import {
  m0014DirectMessages,
  m0026DmReactions,
  m0034DmConversationsLastSent,
  m0035DmConversationsLastSentAt,
  m0036DmConversationsCanonicalCounterparty,
  m0040DmMessagesTagsMentions,
  m0041DmReactionsUnicodeImage,
} from "./migrations/dms.ts";
import {
  m0005GroupsAndMembers,
  m0006Channels,
  m0007JoinRequests,
  m0009Invites,
  m0022ChannelPermissions,
  m0024GroupRoles,
  m0025GroupMembersDisplayNameOverride,
  m0027GroupsAvatar,
} from "./migrations/groups.ts";
import {
  m0001AppMeta,
  m0002ProviderKeys,
  m0003UsersAndBootstrapTokens,
  m0004DeviceKeys,
  m0008UsersGuestColumns,
  m0016UsersProfileColumns,
  m0032ProviderAdmin,
} from "./migrations/identity.ts";
import {
  m0010Messages,
  m0011MessagesClientMessageIdUnique,
  m0012Reactions,
  m0013Media,
  m0023MessagesReplyTo,
  m0028ReadMarkers,
  m0037MessagesMetadata,
  m0038MediaDurationMs,
  m0039MessagesMentionsArticle,
  m0042MessagesEditUntilNullable,
} from "./migrations/messages.ts";
import {
  m0020NotificationEndpoints,
  m0029Notifications,
  m0030Push,
  m0031NotificationPreferences,
} from "./migrations/notifications.ts";
import {
  m0015Contacts,
  m0017PrivacySettings,
  m0018Presence,
  m0019Follows,
} from "./migrations/social.ts";

export { MigrationDeferred } from "./migration-types.ts";
export type { Migration, MigrationContext } from "./migration-types.ts";

/**
 * The `domain` boot hands {@link migrate}: the canonical DOMAIN when the operator
 * configured one, else `undefined` — the localhost fallback (`domainIsDefault`)
 * is never trusted to be the authority stored data was written under.
 */
export function migrationDomain(
  config: Pick<Config, "domain" | "domainIsDefault">,
): string | undefined {
  return config.domainIsDefault ? undefined : canonicalAuthority(config.domain);
}

/**
 * Ordered, forward-only migration list. Append new migrations; do not edit or
 * reorder existing ones once shipped. Each one lives with its domain in
 * `migrations/*.ts`.
 */
export const migrations: readonly Migration[] = [
  m0001AppMeta,
  m0002ProviderKeys,
  m0003UsersAndBootstrapTokens,
  m0004DeviceKeys,
  m0005GroupsAndMembers,
  m0006Channels,
  m0007JoinRequests,
  m0008UsersGuestColumns,
  m0009Invites,
  m0010Messages,
  m0011MessagesClientMessageIdUnique,
  m0012Reactions,
  m0013Media,
  m0014DirectMessages,
  m0015Contacts,
  m0016UsersProfileColumns,
  m0017PrivacySettings,
  m0018Presence,
  m0019Follows,
  m0020NotificationEndpoints,
  m0021KnownProviders,
  m0022ChannelPermissions,
  m0023MessagesReplyTo,
  m0024GroupRoles,
  m0025GroupMembersDisplayNameOverride,
  m0026DmReactions,
  m0027GroupsAvatar,
  m0028ReadMarkers,
  m0029Notifications,
  m0030Push,
  m0031NotificationPreferences,
  m0032ProviderAdmin,
  m0033DiscoverFeatures,
  m0034DmConversationsLastSent,
  m0035DmConversationsLastSentAt,
  m0036DmConversationsCanonicalCounterparty,
  m0037MessagesMetadata,
  m0038MediaDurationMs,
  m0039MessagesMentionsArticle,
  m0040DmMessagesTagsMentions,
  m0041DmReactionsUnicodeImage,
  m0042MessagesEditUntilNullable,
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
 * `ctx.domain` is the provider's canonical authority (needed by data migrations
 * that reason about local actors, e.g. 0036). See {@link runMigrations}.
 */
export function migrate(db: Db, ctx: MigrationContext = {}): string[] {
  return runMigrations(db, migrations, ctx);
}

/**
 * Apply the not-yet-applied entries of `list`, in order. Each migration is
 * atomic (its changes + ledger row commit together). One that throws
 * {@link MigrationDeferred} is rolled back, left unapplied and reported via
 * `ctx.onDeferred` (once per run); the run continues past it only if it is
 * `independent`, else STOPS there so later migrations wait (strict ordering).
 * Exported for tests (synthetic migration lists).
 */
export function runMigrations(
  db: Db,
  list: readonly Migration[],
  ctx: MigrationContext = {},
): string[] {
  const { sqlite } = db;
  sqlite.exec(LEDGER_DDL);

  const appliedRows = sqlite.query<{ id: string }, []>("SELECT id FROM _migrations").all();
  const applied = new Set(appliedRows.map((r) => r.id));

  const record = sqlite.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)");

  const newlyApplied: string[] = [];
  for (const m of list) {
    if (applied.has(m.id)) continue;
    try {
      sqlite.transaction(() => {
        m.up(sqlite, ctx);
        record.run(m.id, Date.now());
      })();
    } catch (err) {
      if (!(err instanceof MigrationDeferred)) throw err;
      // Rolled back and unledgered: retried next boot. Only an `independent`
      // migration may be skipped; any other holds back everything after it.
      (ctx.onDeferred ?? ((id, reason) => console.warn(`[migrate] ${id} deferred: ${reason}`)))(
        m.id,
        err.message,
      );
      if (m.independent) continue;
      break;
    }
    newlyApplied.push(m.id);
  }

  return newlyApplied;
}
