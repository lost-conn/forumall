/**
 * Drizzle tables — Channel messages, reactions, media and read markers (§5.3, §5.8, §7.1–§7.2).
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Messages (spec §5.3, §7.2). One row per chat/memo/article message in a
 * channel. Reactions are a separate object/table (later card), so `type` here
 * is `message|memo|article` only.
 *
 * `content`, `attachments`, `reference`, `tags` and `mentions` are stored as JSON text and
 * mapped to the shared `Message` shape at the read boundary
 * (`provider/messages.ts`). `reference`/`edited_at`/`deleted_at`/`client_message_id`
 * are nullable.
 *
 * ## Timeline position (`seq`)
 * `seq` is a globally-monotonic integer (assigned `MAX(seq)+1` within the
 * insert transaction) that defines a message's absolute timeline position and
 * is the **basis of the opaque history cursor** (§7.2) — REST history and the
 * WS resume `since` cursor (§7.1) share this one cursor space. The
 * `(channel_id, seq)` index makes per-channel keyset paging over `seq` a range
 * scan. `seq` is globally unique (a UNIQUE index enforces it), so a cursor
 * never collides across channels.
 *
 * `edit_until` is the absolute time (epoch millis) after which the message may
 * no longer be edited (§5.3 `permissions.editUntil`); `message.update` enforces
 * it. `deleted_at` (nullable) is the tombstone marker (§7.1): a tombstoned
 * message is retained and still returned by history so reply references and
 * resume cursors stay valid.
 *
 * `client_message_id` (nullable) is the §7.1 idempotency key of a create, over
 * WS and REST alike: `(author, channel_id, client_message_id)` is unique, and a
 * create that matches it answers with the stored row. It is stored with the
 * message so every copy the author receives echoes it — the create response,
 * live `message.created` and `subscribe.since` replays — and history includes
 * it too (§7.1 lets a provider show it in other copies). Deleting the owning
 * group/channel cascades to its messages.
 */
export const messages = sqliteTable(
  "messages",
  {
    /** Stable message id, e.g. `msg_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** FK to `channels.id`. */
    channelId: text("channel_id").notNull(),
    /** FK to `groups.id` (denormalized for cascade + group-scoped reads). */
    groupId: text("group_id").notNull(),
    /** Author actor (`handle@domain`). */
    author: text("author").notNull(),
    /** Message kind: `message` | `memo` | `article`. */
    type: text("type").notNull(),
    /** Body, stored as JSON (`{ text, mime }`). */
    content: text("content").notNull(),
    /** Attachment list, stored as JSON (`Attachment[]`). */
    attachments: text("attachments").notNull(),
    /** Optional typed reference (reply etc.), stored as JSON `{ type, id }`. */
    reference: text("reference"),
    /**
     * Parent message id for a reply (`reference.id`), denormalized out of
     * `reference` so the reply listing (§7.2) can index + query it directly.
     * Null for a top-level message. Populated on create; added in migration 0023.
     */
    replyTo: text("reply_to"),
    /** Tag list, stored as JSON (`string[]`). */
    tags: text("tags").notNull(),
    /** Globally-monotonic timeline position; basis of the §7.2 cursor. */
    seq: integer("seq", { mode: "number" }).notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    /** Last-edit time (epoch millis); null until edited. `editedAt`. */
    editedAt: integer("edited_at", { mode: "number" }),
    /** Tombstone time (epoch millis); null unless deleted. `deletedAt` (§7.1). */
    deletedAt: integer("deleted_at", { mode: "number" }),
    /** Edit-window end (epoch millis); `permissions.editUntil` (§5.3). */
    editUntil: integer("edit_until", { mode: "number" }).notNull(),
    /**
     * Client-chosen idempotency key (§7.1): `(author, channel_id,
     * client_message_id)` is unique; echoed as `clientMessageId`. Nullable.
     */
    clientMessageId: text("client_message_id"),
    /** Metadata objects (§5.4), stored as JSON (`MetadataList`). Added in 0037. */
    metadata: text("metadata").notNull(),
    /**
     * Mentioned actors (§5.3), stored as JSON (`string[]`); null when the
     * message never carried `mentions` (then they are parsed from the text,
     * §10.1). Added in 0039.
     */
    mentions: text("mentions"),
    /** Article title (§5.3); null when absent. Only set on `article`. Added in 0039. */
    title: text("title"),
    /** Article summary (§5.3); null when absent. Only set on `article`. Added in 0039. */
    summary: text("summary"),
    /**
     * Article cover (§5.3): the `id` of one of the message's own `attachments`;
     * null when absent. Only set on `article`. Added in 0039.
     */
    cover: text("cover"),
  },
  (t) => ({
    channelSeqIdx: index("idx_messages_channel_seq").on(t.channelId, t.seq),
    seqIdx: uniqueIndex("idx_messages_seq").on(t.seq),
    // Reply listing (§7.2): all replies to a parent, in cursor order.
    replyToIdx: index("idx_messages_channel_reply_to").on(t.channelId, t.replyTo, t.seq),
    // WS-create idempotency (§7.1): at most one message per
    // (author, channelId, clientMessageId). Partial — only rows that carry an
    // idempotency key participate; keyless messages are unconstrained.
    clientMsgIdx: uniqueIndex("idx_messages_author_channel_client_msg")
      .on(t.author, t.channelId, t.clientMessageId)
      .where(sql`${t.clientMessageId} IS NOT NULL`),
  }),
);

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

/**
 * Reactions (spec §5.3, §7.1). One row per (message, author, key): a user may
 * hold at most ONE reaction per `key` per message, enforced by the unique
 * `(message_id, author, key)` index — `addReaction` is idempotent against it.
 * OFSCP v0.1 does NOT store a server-aggregated count; clients aggregate totals
 * from these rows / the `reaction.added`/`reaction.removed` events (§7.1).
 *
 * `channel_id` / `group_id` are denormalized (from the target message) so the
 * fan-out + authorization paths and cascade deletes do not need a message join.
 * `unicode` / `image` are nullable (a reaction MAY carry either or neither). The
 * canonical `Reaction.reference` is always `{ type: "message", id: message_id }`
 * (re-derived at the read boundary in `provider/reactions.ts`), so no separate
 * reference column is stored. The `message_id` index backs the listing endpoint.
 */
export const reactions = sqliteTable(
  "reactions",
  {
    /** Stable reaction id, e.g. `rct_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** FK to `messages.id` — the reacted-to message. */
    messageId: text("message_id").notNull(),
    /** FK to `channels.id` (denormalized for fan-out + cascade). */
    channelId: text("channel_id").notNull(),
    /** FK to `groups.id` (denormalized for cascade + group-scoped reads). */
    groupId: text("group_id").notNull(),
    /** Reacting actor (`handle@domain`). */
    author: text("author").notNull(),
    /** Reaction key (e.g. `heart`); the dedupe axis with author + message. */
    key: text("key").notNull(),
    /** Optional unicode glyph (e.g. `❤️`). */
    unicode: text("unicode"),
    /** Optional https image/GIF URL. */
    image: text("image"),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // One reaction per (message, author, key): adding the same key again is a
    // no-op (idempotent in `addReaction`).
    uniqueIdx: uniqueIndex("idx_reactions_message_author_key").on(t.messageId, t.author, t.key),
    // Listing reactions for a message (§7.1 history / late-joiners).
    messageIdx: index("idx_reactions_message_id").on(t.messageId),
  }),
);

export type ReactionRow = typeof reactions.$inferSelect;
export type NewReactionRow = typeof reactions.$inferInsert;

/**
 * Media / attachments (spec §5.8). One row per uploaded blob; the raw bytes live
 * in the {@link StorageBackend} (filesystem by default) keyed by `id`, this table
 * holds the metadata that builds the hosted `Attachment` (§5.3, §5.8). `hash` is
 * the content-integrity digest in `<algo>:<base64>` form (`sha-256:…`) so
 * recipients can verify integrity. `width`/`height` (pixels) and `durationMs`
 * are set once at upload (§5.8): from the file's own header when the provider
 * can read it, otherwise from the uploader's validated form parts; each is
 * nullable (absent when neither side supplied it). `owner` is the
 * authenticated actor (`handle@domain`) that uploaded the file.
 */
export const media = sqliteTable(
  "media",
  {
    /** Provider-generated stable id, e.g. `att_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** Stored content type (IANA media type), served back on GET. */
    mime: text("mime").notNull(),
    /** Size of the stored blob in bytes. */
    size: integer("size", { mode: "number" }).notNull(),
    /** Optional original filename supplied with the upload. */
    filename: text("filename"),
    /** Content-integrity digest in `<algo>:<base64>` form (`sha-256:…`). */
    hash: text("hash").notNull(),
    /** Width in pixels (from the file, else the uploader); null when unknown. */
    width: integer("width", { mode: "number" }),
    /** Height in pixels (from the file, else the uploader); null when unknown. */
    height: integer("height", { mode: "number" }),
    /** Audio/video duration in ms (from the uploader); null when unknown. Added in 0038. */
    durationMs: integer("duration_ms", { mode: "number" }),
    /** Uploading actor (`handle@domain`). */
    owner: text("owner").notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 when needed. */
    createdAt: integer("created_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    ownerIdx: index("idx_media_owner").on(t.owner),
  }),
);

export type MediaRow = typeof media.$inferSelect;
export type NewMediaRow = typeof media.$inferInsert;

/**
 * Per-user read markers (read/unread tracking). One row per (local user `handle`,
 * `scopeId`), where `scopeId` is a channel id (`chn_…`) OR a DM conversation id
 * (`dmId`, §7.4). One unified table is correct because the global monotonic `seq`
 * space already spans both channel `messages` and `dm_messages` — a single
 * `last_read_seq` value compares against either store.
 *
 *  - `handle` keys on the LOCAL user (matching `privacy_settings` / `presence`),
 *    NOT a canonical `handle@domain` actor — read state is private, per-account,
 *    and never federated.
 *  - `last_read_seq` is the highest `seq` the user has read in this scope; unread
 *    is `COUNT(seq > last_read_seq)` excluding the user's own messages.
 *  - markers are **monotonic** — `setReadMarkers` never moves one backward.
 *
 * The `handle` index backs the per-user unread-summary query.
 */
export const readMarkers = sqliteTable(
  "read_markers",
  {
    /** The LOCAL user handle this marker belongs to. */
    handle: text("handle").notNull(),
    /** Scope: a channel id (`chn_…`) or a DM conversation id (`dmId`, §7.4). */
    scopeId: text("scope_id").notNull(),
    /** Highest `seq` the user has read in this scope (monotonic). */
    lastReadSeq: integer("last_read_seq", { mode: "number" }).notNull(),
    /** Last-update time (epoch millis). */
    updatedAt: integer("updated_at", { mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.handle, t.scopeId] }),
    // Per-user summary: all of a user's markers in one keyset.
    handleIdx: index("idx_read_markers_handle").on(t.handle),
  }),
);

export type ReadMarkerRow = typeof readMarkers.$inferSelect;
export type NewReadMarkerRow = typeof readMarkers.$inferInsert;
