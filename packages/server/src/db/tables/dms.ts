/**
 * Drizzle tables — Direct messages: inbox rows, conversation pointers and DM reactions (§7.4).
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
 * Direct-message inbox (spec §7.4, §8.3). One row per message stored in a LOCAL
 * recipient's inbox for a conversation. Per §8.3, the recipient's home provider
 * is the SOLE authoritative store — there is NO sender copy — so a DM lives only
 * here, in `owner`'s inbox (`owner` is the local recipient handle).
 *
 * `dm_id` is the deterministic two-party conversation id (`deriveDmId`, §7.4).
 * `author` is the sending actor (`handle@domain`); `content` / `attachments` /
 * `reference` mirror the §5.3 message fields (JSON text). `seq` is the SAME
 * globally-monotonic timeline position used by channel messages (`MAX(seq)+1`
 * across `messages` ∪ `dm_messages`), so the opaque history/`dm.message` cursor
 * is one shared space. `edited_at` / `deleted_at` support author edit/tombstone
 * (§7.1 rules applied to the stored copy). `client_message_id` backs
 * `(owner, dm_id, author, client_message_id)` idempotency (§7.1).
 */
export const dmMessages = sqliteTable(
  "dm_messages",
  {
    /** Stable message id, e.g. `msg_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** Deterministic two-party conversation id (`deriveDmId`, §7.4). */
    dmId: text("dm_id").notNull(),
    /** The LOCAL recipient handle whose inbox this row belongs to. */
    owner: text("owner").notNull(),
    /** Sending actor (`handle@domain`). */
    author: text("author").notNull(),
    /** Body, stored as JSON (`{ text, mime }`). */
    content: text("content").notNull(),
    /** Attachment list, stored as JSON (`Attachment[]`). */
    attachments: text("attachments").notNull(),
    /** Optional typed reference (reply etc.), stored as JSON `{ type, id }`. */
    reference: text("reference"),
    /** Globally-monotonic timeline position; basis of the shared §7.2 cursor. */
    seq: integer("seq", { mode: "number" }).notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" }).notNull(),
    /** Last-edit time (epoch millis); null until edited. `editedAt`. */
    editedAt: integer("edited_at", { mode: "number" }),
    /** Tombstone time (epoch millis); null unless deleted. `deletedAt` (§7.1). */
    deletedAt: integer("deleted_at", { mode: "number" }),
    /** Edit-window end (epoch millis); `permissions.editUntil` (§5.3). */
    editUntil: integer("edit_until", { mode: "number" }).notNull(),
    /** Client-supplied idempotency key; nullable. */
    clientMessageId: text("client_message_id"),
  },
  (t) => ({
    // Per-inbox conversation timeline read (§7.4): keyset paging over `seq`.
    ownerDmSeqIdx: index("idx_dm_messages_owner_dm_seq").on(t.owner, t.dmId, t.seq),
    // Idempotency (§7.1): at most one message per
    // (owner, dmId, author, clientMessageId). Partial — only keyed rows.
    clientMsgIdx: uniqueIndex("idx_dm_messages_owner_dm_author_client_msg")
      .on(t.owner, t.dmId, t.author, t.clientMessageId)
      .where(sql`${t.clientMessageId} IS NOT NULL`),
  }),
);

export type DmMessageRow = typeof dmMessages.$inferSelect;
export type NewDmMessageRow = typeof dmMessages.$inferInsert;

/**
 * Per-inbox DM conversation summary (spec §7.4). One row per (owner, dm_id):
 * upserted whenever a message lands in `owner`'s inbox. Backs the conversation
 * listing (`GET /api/me/dms`) AND participation checks (a row's existence means
 * `owner` is a participant of `dm_id`). `counterparty` is the other actor.
 */
export const dmConversations = sqliteTable(
  "dm_conversations",
  {
    /** The LOCAL recipient handle whose inbox this conversation belongs to. */
    owner: text("owner").notNull(),
    /** Deterministic two-party conversation id (`deriveDmId`, §7.4). */
    dmId: text("dm_id").notNull(),
    /** The other actor in the conversation (`handle@domain`). */
    counterparty: text("counterparty").notNull(),
    /** Last-activity time (epoch millis); rendered as RFC 3339 `updatedAt`. */
    updatedAt: integer("updated_at", { mode: "number" }).notNull(),
    /** `seq` of the newest message in this inbox conversation (0 = none yet). */
    lastMessageSeq: integer("last_message_seq", { mode: "number" }).notNull(),
    /**
     * Non-authoritative cached copy (JSON `Message`) of the newest message the
     * owner SENT in this conversation, from a conversation pointer (OFSCP §7.4).
     * The authoritative copy lives in the counterparty's inbox.
     */
    lastSentMessage: text("last_sent_message"),
    /**
     * When THIS provider stored `lastSentMessage` (epoch millis). Decides which
     * preview is newer (§7.4) instead of the client-supplied `createdAt` inside
     * it. Set only when `lastSentMessage` is written; NULL on legacy rows.
     */
    lastSentAt: integer("last_sent_at", { mode: "number" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.owner, t.dmId] }),
    // Listing the owner's conversations newest-first (§7.4).
    ownerUpdatedIdx: index("idx_dm_conversations_owner_updated").on(t.owner, t.updatedAt),
  }),
);

export type DmConversationRow = typeof dmConversations.$inferSelect;
export type NewDmConversationRow = typeof dmConversations.$inferInsert;

/**
 * DM reactions (spec §7.4, mirroring §5.3/§7.1 channel reactions). One row per
 * (dm_id, message_id, author, key): a user may hold at most ONE reaction per
 * `key` per DM message, enforced by the unique `(dm_id, message_id, author,
 * key)` index — the add is idempotent against it, exactly like channel
 * `reactions`.
 *
 * ## Storage-follows-message (§8.3)
 * A DM message lives ONLY in its recipient's inbox at the recipient's home
 * provider (there is no sender copy). A reaction targets that message, so it is
 * stored at the SAME provider the message lives on, scoped by `(dm_id,
 * message_id)`. The inbox `owner` is therefore implicit (the single inbox that
 * holds `message_id` for `dm_id` on this provider), so — unlike channel
 * reactions — no group/channel denormalization is needed. When the local user
 * reacts to a message they SENT to a remote peer (no local copy here), the HTTP
 * layer forwards the reaction to the peer's provider rather than storing it
 * here (see `http/dms.ts`).
 *
 * `unicode` is omitted (DM reactions in v0.1 carry only a `key`, like the
 * channel `reaction.add` minimal form); the canonical `Reaction.reference` is
 * re-derived as `{ type: "message", id: message_id }` at the read boundary. The
 * `(dm_id, message_id)` index backs the per-message aggregation on history reads.
 */
export const dmReactions = sqliteTable(
  "dm_reactions",
  {
    /** Stable reaction id, e.g. `rct_<base64url>`. Primary key. */
    id: text("id").primaryKey(),
    /** Deterministic two-party conversation id (`deriveDmId`, §7.4). */
    dmId: text("dm_id").notNull(),
    /** FK to `dm_messages.id` — the reacted-to DM message. */
    messageId: text("message_id").notNull(),
    /** Reacting actor (`handle@domain`). */
    author: text("author").notNull(),
    /** Reaction key (e.g. `heart`); the dedupe axis with author + message. */
    key: text("key").notNull(),
    /** Creation time (epoch millis); rendered as RFC 3339 `createdAt`. */
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // One reaction per (dm, message, author, key): adding the same key again is
    // a no-op (idempotent in `addDmReaction`).
    uniqueIdx: uniqueIndex("idx_dm_reactions_dm_message_author_key").on(
      t.dmId,
      t.messageId,
      t.author,
      t.key,
    ),
    // Aggregating reactions for a DM message (history reads / fan-out).
    dmMessageIdx: index("idx_dm_reactions_dm_message").on(t.dmId, t.messageId),
  }),
);

export type DmReactionRow = typeof dmReactions.$inferSelect;
export type NewDmReactionRow = typeof dmReactions.$inferInsert;
