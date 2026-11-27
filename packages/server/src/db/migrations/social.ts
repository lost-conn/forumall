/**
 * Migrations for contacts, privacy settings, presence and follows. The run order is the
 * `migrations` list in `../migrate.ts`; never edit or rename a shipped one.
 */
import { canonicalAuthority } from "@forumall/shared";

import { type Migration, MigrationDeferred } from "../migration-types.ts";

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

/** 0044: a canonical channel URI path (§2.2), capturing the channel id. */
const M0044_CHANNEL_URI_PATH =
  /^\/api\/groups\/[A-Za-z0-9_-]{1,128}\/channels\/([A-Za-z0-9_-]{1,128})$/;

/**
 * 0044: the one stored spelling of a legacy follow `channel` URI under this
 * provider's canonical `domain` (§2.2), or `null` when it names no followable
 * object. Kept here, not imported from `provider/follows.ts`, so the
 * migration's behaviour never changes with the runtime code.
 */
function m0044FollowKey(domain: string, channel: string): string | null {
  let url: URL;
  try {
    url = new URL(channel);
  } catch {
    return null;
  }
  if (canonicalAuthority(url.host) === domain) {
    // Followed by this provider's own URI (http or https, maybe with a query
    // or fragment): the follow is of the local channel → its bare id.
    return url.pathname.match(M0044_CHANNEL_URI_PATH)?.[1] ?? null;
  }
  // A remote object URI is HTTPS (§2.2): an http:// pointer names no object.
  if (url.protocol !== "https:") return null;
  // An object URI carries no query or fragment: the object is the path.
  return channel.split(/[?#]/, 1)[0] ?? null;
}

export const m0044FollowsCanonicalChannelRefs: Migration = {
  // §2.2 for follows stored before the ref rules were enforced: a provider
  // MUST treat its own object URI exactly like the local id, and object URIs
  // are HTTPS with no query or fragment. Each URI row's `channel` is rewritten
  // to the one spelling the runtime stores (`provider/follows.ts` `followKey`):
  //  - this provider's channel URI (http or https, any query/fragment) → the
  //    bare channel id;
  //  - a remote https URI with a query or fragment → the URI without them;
  //  - a remote http:// URI, or an unparsable or non-channel local URI → the
  //    row is DELETED (it names no followable object, and the runtime would
  //    answer 400 to an unfollow naming it).
  // Rows that become one follow are folded into the one already stored under
  // that spelling, keeping the earliest `created_at`. Telling local URIs from
  // remote ones needs this provider's authority, so with no configured DOMAIN
  // it DEFERS (independent: nothing later depends on it); until then a legacy
  // local-URI row is still rendered as the local channel it names. Data-only
  // and idempotent; logs what it rewrote, folded and deleted.
  id: "0044_follows_canonical_channel_refs",
  independent: true,
  up: (sqlite, ctx) => {
    // Bare local ids hold no ':'; every other stored ref was accepted as a URI.
    const legacy = sqlite
      .query<{ owner: string; channel: string; created_at: number }, []>(
        "SELECT owner, channel, created_at FROM follows WHERE instr(channel, ':') > 0 ORDER BY created_at, rowid",
      )
      .all();
    if (legacy.length === 0) return;
    const domain = ctx.domain;
    if (domain === undefined) {
      throw new MigrationDeferred(
        "DOMAIN is not configured, so followed channel URIs cannot be told local from remote. Set DOMAIN to this provider's public hostname (a localhost-only install can ignore this); such follows keep their stored spelling meanwhile",
      );
    }
    const stored = sqlite.prepare<{ one: number }, [string, string]>(
      "SELECT 1 AS one FROM follows WHERE owner = ? AND channel = ?",
    );
    const rename = sqlite.prepare("UPDATE follows SET channel = ? WHERE owner = ? AND channel = ?");
    const keepEarliest = sqlite.prepare(
      "UPDATE follows SET created_at = MIN(created_at, ?) WHERE owner = ? AND channel = ?",
    );
    const remove = sqlite.prepare("DELETE FROM follows WHERE owner = ? AND channel = ?");
    let rewritten = 0;
    let folded = 0;
    let deleted = 0;
    for (const r of legacy) {
      const key = m0044FollowKey(domain, r.channel);
      if (key === r.channel) continue;
      if (key === null) {
        remove.run(r.owner, r.channel);
        deleted++;
      } else if (stored.get(r.owner, key)) {
        keepEarliest.run(r.created_at, r.owner, key);
        remove.run(r.owner, r.channel);
        folded++;
      } else {
        rename.run(key, r.owner, r.channel);
        rewritten++;
      }
    }
    (ctx.log ?? console.log)(
      `0044: follows — ${rewritten} channel ref(s) rewritten, ${folded} folded into an existing follow, ${deleted} non-object ref(s) deleted`,
    );
  },
};
