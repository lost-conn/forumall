/**
 * Migrations for channel messages, reactions, media and read markers. The run order is the
 * `migrations` list in `../migrate.ts`; never edit or rename a shipped one.
 */
import type { Migration } from "../migration-types.ts";

export const m0010Messages: Migration = {
  // Messages (§5.3, §7.2). `seq` is the globally-monotonic timeline position
  // and basis of the §7.2 opaque cursor (shared with §7.1 WS resume). The
  // (channel_id, seq) index backs per-channel keyset paging; the unique seq
  // index keeps the cursor globally unambiguous.
  id: "0010_messages",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id                TEXT PRIMARY KEY,
        channel_id        TEXT NOT NULL,
        group_id          TEXT NOT NULL,
        author            TEXT NOT NULL,
        type              TEXT NOT NULL,
        content           TEXT NOT NULL,
        attachments       TEXT NOT NULL,
        reference         TEXT,
        tags              TEXT NOT NULL,
        seq               INTEGER NOT NULL,
        created_at        INTEGER NOT NULL,
        edited_at         INTEGER,
        deleted_at        INTEGER,
        edit_until        INTEGER NOT NULL,
        client_message_id TEXT
      ) STRICT;
    `);
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages (channel_id, seq);",
    );
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages (seq);");
  },
};

export const m0011MessagesClientMessageIdUnique: Migration = {
  // WS create idempotency (§7.1): `(author, channelId, clientMessageId)` is
  // idempotent. A PARTIAL unique index (only where client_message_id is not
  // null) enforces "at most one message per (author, channel, key)" while
  // still permitting unlimited rows that carry no idempotency key.
  id: "0011_messages_client_message_id_unique",
  up: (sqlite) => {
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_author_channel_client_msg
         ON messages (author, channel_id, client_message_id)
         WHERE client_message_id IS NOT NULL;`,
    );
  },
};

export const m0012Reactions: Migration = {
  // Reactions (§5.3, §7.1). At most one reaction per (message, author, key)
  // enforced by the unique index (idempotent add). The message_id index backs
  // the paginated listing endpoint. No server-aggregated count column —
  // clients aggregate from these rows / the reaction.* events.
  id: "0012_reactions",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        id         TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        group_id   TEXT NOT NULL,
        author     TEXT NOT NULL,
        key        TEXT NOT NULL,
        unicode    TEXT,
        image      TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_message_author_key
         ON reactions (message_id, author, key);`,
    );
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON reactions (message_id);");
  },
};

export const m0013Media: Migration = {
  // Media / attachments (§5.8). Metadata for uploaded blobs; the raw bytes
  // live in the storage backend (filesystem by default), keyed by `id`. The
  // owner index backs per-user media listings.
  id: "0013_media",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS media (
        id         TEXT PRIMARY KEY,
        mime       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        filename   TEXT,
        hash       TEXT NOT NULL,
        width      INTEGER,
        height     INTEGER,
        owner      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_media_owner ON media (owner);");
  },
};

export const m0023MessagesReplyTo: Migration = {
  // Reply listing (§7.2): denormalize the reply parent id out of the
  // `reference` JSON into its own nullable column so it can be indexed +
  // queried directly. Backfill existing rows via json_extract, then index
  // (channel_id, reply_to, seq) for cursor-ordered reply pages.
  id: "0023_messages_reply_to",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("reply_to")) {
      sqlite.exec("ALTER TABLE messages ADD COLUMN reply_to TEXT;");
      // Backfill: a reply has reference.type === "reply"; pull reference.id.
      sqlite.exec(`
        UPDATE messages
           SET reply_to = json_extract(reference, '$.id')
         WHERE reference IS NOT NULL
           AND json_valid(reference)
           AND json_extract(reference, '$.type') = 'reply';
      `);
    }
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_channel_reply_to ON messages (channel_id, reply_to, seq);",
    );
  },
};

export const m0028ReadMarkers: Migration = {
  // Read markers (Overboard "Read/new messages history"): per-user last-read
  // position per channel + per DM, backing unread counts and the "New
  // messages" divider. One unified table keyed (handle, scope_id) — the global
  // `seq` space already spans channel `messages` + `dm_messages`, so one
  // `last_read_seq` works for both. The handle index backs the per-user unread
  // summary. Create-if-not-exists DDL; guarded so a re-run is a no-op.
  id: "0028_read_markers",
  up: (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS read_markers (
        handle        TEXT NOT NULL,
        scope_id      TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (handle, scope_id)
      ) STRICT;
    `);
    sqlite.exec("CREATE INDEX IF NOT EXISTS idx_read_markers_handle ON read_markers (handle);");
  },
};

export const m0037MessagesMetadata: Migration = {
  // Message metadata (§5.4, §7.1): a create stores the `metadata` it carries
  // (omitted → []). Existing rows had none, so the NOT NULL default backfills
  // them with an empty list. Guarded so a re-run is a no-op.
  id: "0037_messages_metadata",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(messages)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("metadata")) {
      sqlite.exec("ALTER TABLE messages ADD COLUMN metadata TEXT NOT NULL DEFAULT '[]';");
    }
  },
};

export const m0038MediaDurationMs: Migration = {
  // Attachment duration (§5.8): `durationMs` for audio/video, taken from the
  // uploader's `durationMs` form part when the provider cannot read it from the
  // file. Nullable (absent for most uploads); existing rows had none. Guarded
  // so a re-run is a no-op.
  id: "0038_media_duration_ms",
  up: (sqlite) => {
    const cols = sqlite
      .query<{ name: string }, []>("PRAGMA table_info(media)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("duration_ms")) {
      sqlite.exec("ALTER TABLE media ADD COLUMN duration_ms INTEGER;");
    }
  },
};
