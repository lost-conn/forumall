/**
 * Migrations for direct messages, DM reactions and conversation pointers (incl. the 0036 pointer-hygiene data migration). The run order is the
 * `migrations` list in `../migrate.ts`; never edit or rename a shipped one.
 */
import { canonicalActor, deriveDmId } from "@forumall/shared";
import { type Migration, MigrationDeferred } from "../migration-types.ts";

/** 0036 sanity guard: refuse when more than this many rows AND over half fail. */
const DM_HYGIENE_MAX_UNGUARDED_FAILURES = 5;

export const m0014DirectMessages: Migration = {
  // Direct messages (§7.4, §8.3). `dm_messages` is the recipient's inbox (no
  // sender copy); `seq` shares the global timeline space with `messages` so
  // the §7.2 cursor/`dm.message` cursor is one space. `dm_conversations` is the
  // per-inbox summary that backs listing AND participation checks. The
  // partial unique index enforces (owner, dm_id, author, client_message_id)
  // idempotency only for keyed rows.
  id: "0014_direct_messages",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS dm_messages (
        id                TEXT PRIMARY KEY,
        dm_id             TEXT NOT NULL,
        owner             TEXT NOT NULL,
        author            TEXT NOT NULL,
        content           TEXT NOT NULL,
        attachments       TEXT NOT NULL,
        reference         TEXT,
        seq               INTEGER NOT NULL,
        created_at        INTEGER NOT NULL,
        edited_at         INTEGER,
        deleted_at        INTEGER,
        edit_until        INTEGER NOT NULL,
        client_message_id TEXT
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_dm_messages_owner_dm_seq ON dm_messages (owner, dm_id, seq);",
    );
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_messages_owner_dm_author_client_msg
         ON dm_messages (owner, dm_id, author, client_message_id)
         WHERE client_message_id IS NOT NULL;`,
    );
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS dm_conversations (
        owner             TEXT NOT NULL,
        dm_id             TEXT NOT NULL,
        counterparty      TEXT NOT NULL,
        updated_at        INTEGER NOT NULL,
        last_message_seq  INTEGER NOT NULL,
        PRIMARY KEY (owner, dm_id)
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_dm_conversations_owner_updated ON dm_conversations (owner, updated_at);",
    );
  },
};

export const m0026DmReactions: Migration = {
  // DM reactions (Overboard "DMs need replies/reactions/all chat
  // functionality"): one row per (dm_id, message_id, author, key), mirroring
  // the channel `reactions` table. Stored at the provider where the target DM
  // message lives (storage-follows-message, §8.3). Create-if-not-exists DDL +
  // the unique/aggregation indexes; guarded so a re-run is a no-op.
  id: "0026_dm_reactions",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS dm_reactions (
        id         TEXT PRIMARY KEY,
        dm_id      TEXT NOT NULL,
        message_id TEXT NOT NULL,
        author     TEXT NOT NULL,
        key        TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_reactions_dm_message_author_key ON dm_reactions (dm_id, message_id, author, key);",
    );
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_dm_reactions_dm_message ON dm_reactions (dm_id, message_id);",
    );
  },
};

export const m0034DmConversationsLastSent: Migration = {
  // DM conversation pointers (OFSCP §7.4): a nullable cached copy of the
  // newest message the owner SENT, so a conversation the owner started (no
  // inbox message yet) lists with a preview and syncs to their other
  // devices. ADD COLUMN is safe on a STRICT table (nullable, no default).
  // Guarded so a re-run is a no-op.
  id: "0034_dm_conversations_last_sent",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(dm_conversations)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("last_sent_message")) {
      sqlite.exec("ALTER TABLE dm_conversations ADD COLUMN last_sent_message TEXT;");
    }
  },
};

export const m0035DmConversationsLastSentAt: Migration = {
  // When the provider stored a pointer's cached `last_sent_message` (OFSCP
  // §7.4): the conversation preview picks the newer of received vs. sent by
  // provider-recorded times, not the client-supplied preview `createdAt`.
  // Nullable, no backfill: a legacy preview has no trustworthy store time,
  // so it loses to any received message (see `conversationItem`). Guarded so
  // a re-run is a no-op.
  id: "0035_dm_conversations_last_sent_at",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(dm_conversations)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("last_sent_at")) {
      sqlite.exec("ALTER TABLE dm_conversations ADD COLUMN last_sent_at INTEGER;");
    }
  },
};

export const m0036DmConversationsCanonicalCounterparty: Migration = {
  // OFSCP §7.4 pointer hygiene for rows stored before the rules existed:
  //  - a provider MUST serve a pointer's counterparty in canonical actor form,
  //    normalizing values stored before: rewrite each non-canonical
  //    `counterparty` to `canonicalActor(...)` (lowercase handle + canonical
  //    authority; `:443` stripped). The PK is (owner, dm_id): no collision.
  //  - a pointer whose counterparty does not derive its dmId together with the
  //    owner MUST be ignored or deleted. A failing row whose owner's inbox
  //    holds NO message under its dm_id (a pure pointer) is DELETED with the
  //    owner's read marker on that dm_id. A failing row that holds received
  //    messages is KEPT (logged): an old author spelling such as
  //    `bob@host:443` derives a different id than its canonical form, so
  //    deleting the row would orphan those messages. The runtime ignores it.
  // Safety: the derivation check needs the RIGHT provider domain — under a
  // wrong one no row derives its dmId. So the migration DEFERS (rolls back,
  // stays unledgered, retried next boot) when:
  //  - no domain is given (boot passes one only when DOMAIN is configured);
  //  - the domain is not PROVEN by stored data: proven if some row derives
  //    its dm_id under it (a SHA-256 match a wrong domain cannot produce) OR
  //    some local user (`users.handle`) authored a stored channel message
  //    as `handle@domain`. So an install whose rows are all inconsistent but
  //    whose DOMAIN is right still proceeds;
  //  - more than a handful AND more than half of the rows would fail
  //    (left for manual review rather than mass-deleted).
  // It is `independent` (data-only; nothing later depends on it), so a
  // deferral never holds back later migrations. Until it runs, the runtime
  // ignore rule (`conversationDerivesDmId`) applies. Data-only and
  // idempotent; logs how many rows it canonicalized, deleted and kept.
  id: "0036_dm_conversations_canonical_counterparty",
  independent: true,
  up: (sqlite, ctx) => {
    const rows = sqlite
      .query<{ owner: string; dm_id: string; counterparty: string; has_messages: number }, []>(
        `SELECT c.owner, c.dm_id, c.counterparty,
                EXISTS (SELECT 1 FROM dm_messages m WHERE m.owner = c.owner AND m.dm_id = c.dm_id) AS has_messages
           FROM dm_conversations c`,
      )
      .all();
    if (rows.length === 0) return;
    const domain = ctx.domain;
    if (domain === undefined) {
      throw new MigrationDeferred(
        "DOMAIN is not configured, so stored DM conversations cannot be checked. Set DOMAIN to this provider's public hostname (a localhost-only install can ignore this); inconsistent DM pointers stay ignored meanwhile",
      );
    }
    const failing = rows.filter((r) => {
      const canonical = canonicalActor(r.counterparty);
      return canonical === null || deriveDmId(`${r.owner}@${domain}`, canonical) !== r.dm_id;
    });
    // A local user who authored a CHANNEL message as handle@DOMAIN proves
    // DOMAIN. One pass over `messages`, stopping at the first match, with each
    // candidate author looked up by the `users` primary key. (The author-first
    // index on `messages` is partial — `client_message_id IS NOT NULL` — so it
    // can't serve this query.) `dm_messages` is not consulted: a local user's
    // DMs live in the RECIPIENT's inbox, and DM ownership is already covered by
    // the conversation-row derivation above.
    const localChannelAuthor = () =>
      sqlite
        .query<{ one: number }, [string]>(
          `SELECT 1 AS one FROM messages m
            WHERE substr(m.author, -length(?1) - 1) = '@' || ?1
              AND EXISTS (SELECT 1 FROM users u
                           WHERE u.handle = substr(m.author, 1, length(m.author) - length(?1) - 1))
            LIMIT 1`,
        )
        .all(domain).length > 0;
    const domainProven = failing.length < rows.length || localChannelAuthor();
    if (!domainProven) {
      throw new MigrationDeferred(
        `DOMAIN=${domain} cannot be confirmed against stored data (none of the ${rows.length} DM conversation rows derives its id under it and no local user authored a message under it). If DOMAIN is wrong, fix it; if it is right, this resolves once a local user posts a channel message. Nothing was deleted`,
      );
    }
    if (failing.length > DM_HYGIENE_MAX_UNGUARDED_FAILURES && failing.length * 2 > rows.length) {
      throw new MigrationDeferred(
        `${failing.length} of ${rows.length} DM conversation rows are inconsistent under DOMAIN=${domain}, more than half; left for manual review instead of being deleted (they stay ignored at runtime)`,
      );
    }
    const failed = new Set(failing);
    const update = sqlite.prepare(
      "UPDATE dm_conversations SET counterparty = ? WHERE owner = ? AND dm_id = ?",
    );
    const remove = sqlite.prepare("DELETE FROM dm_conversations WHERE owner = ? AND dm_id = ?");
    const removeMarker = sqlite.prepare(
      "DELETE FROM read_markers WHERE handle = ? AND scope_id = ?",
    );
    let canonicalized = 0;
    let deleted = 0;
    let kept = 0;
    for (const r of rows) {
      if (failed.has(r)) {
        if (!r.has_messages) {
          remove.run(r.owner, r.dm_id);
          removeMarker.run(r.owner, r.dm_id);
          deleted++;
        } else {
          kept++;
        }
        continue;
      }
      const canonical = canonicalActor(r.counterparty);
      if (canonical !== null && canonical !== r.counterparty) {
        update.run(canonical, r.owner, r.dm_id);
        canonicalized++;
      }
    }
    (ctx.log ?? console.log)(
      `[migrate] 0036 dm_conversations: ${canonicalized} counterparties canonicalized, ${deleted} inconsistent pointers deleted, ${kept} inconsistent rows with received messages kept (ignored at runtime)`,
    );
  },
};
