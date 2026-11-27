/**
 * Channels + messages store (P8 chat UI). Holds the per-channel message timeline
 * the chat cards render, keyed by channel id, plus reactions, typing indicators,
 * a lightweight channel index, and history-paging cursors.
 *
 * The WS client feeds this via `on("message.created" | "message.updated" |
 * "message.deleted" | "reaction.added" | "reaction.removed" | "channel.typing")`
 * (wired in `components/chat/chat-controller.ts`); REST history (§7.2) backfills
 * the timeline and the reactions endpoint backfills reaction history.
 *
 * ## De-dupe + optimistic echo
 * The timeline is de-duped by message `id`. A locally-composed message gets an
 * OPTIMISTIC entry keyed by its `clientMessageId` (a temporary `id`); when the
 * canonical `message.created` with the same `clientMessageId` arrives we replace
 * the optimistic entry in place rather than appending a duplicate. History +
 * live overlap is also de-duped by `id`.
 *
 * ## Reactions
 * Reaction counts are aggregated CLIENT-SIDE: `reaction.added` / `reaction.removed`
 * events and the per-message reactions endpoint both feed a `(messageId → key →
 * Set<author>)` map, from which the UI derives counts, the emoji, and whether the
 * current user reacted.
 */
import type { Attachment, Reaction } from "@forumall/shared";
import { createStore, produce } from "solid-js/store";
import { cursorAdvances } from "../lib/cursor.ts";
import { mergeCanonical } from "../lib/merge-message.ts";

/** A message as the client cares about it (superset of the WS payload). */
export interface ChatMessage {
  /** Canonical server id, OR a temporary `optimistic:<clientMessageId>` id. */
  id: string;
  author: string;
  /** §5.3 message type: message | memo | article | (unknown → text fallback). */
  type?: string;
  content: { mime?: string; text?: string };
  attachments?: Attachment[];
  /** §5.3 reply pointer: `{ type: "reply", id: <parent message id> }`. */
  reference?: { type: string; id: string };
  /** Advisory count of replies to this message (§7.2), when the server sends it. */
  replyCount?: number;
  /** §5.3 tags (article topics; a `promoted-from:#channel` lineage marker). */
  tags?: string[];
  /** §5.3 article fields (type `article` only): plain-text title and summary. */
  title?: string;
  summary?: string;
  /** §5.3 article cover: the id of one of the message's own attachments. */
  cover?: string;
  createdAt?: string;
  editedAt?: string;
  deletedAt?: string;
  /** Resume cursor delivered alongside the message (§7.1 / §7.2 share a space). */
  cursor?: string;
  /** Set on the local echo until the canonical `message.created` replaces it. */
  clientMessageId?: string;
  /** Optimistic-echo lifecycle: pending → sent (replaced) | failed. */
  pending?: boolean;
  failed?: boolean;
}

export interface ChannelSummary {
  id: string;
  groupId?: string;
  name?: string;
  type?: string;
  tier?: string;
}

/** Aggregated reactions for one message: key → { unicode, authors }. */
export interface ReactionGroup {
  key: string;
  unicode?: string;
  image?: string;
  authors: string[];
}

interface ChatState {
  /** Known channels by id. */
  channels: Record<string, ChannelSummary>;
  /** Message timeline per channel id (ascending by arrival/seq). */
  messages: Record<string, ChatMessage[]>;
  /**
   * Latest resume cursor seen per channel id — the WS `since` on reconnect. Kept
   * as the highest DECODED `seq` (`lib/cursor.ts` `cursorAdvances`), never the
   * "largest" cursor string: the encoding is base64 JSON, so string order flips
   * at every decimal rollover and a wrong pick replays or drops messages.
   */
  cursors: Record<string, string>;
  /** Oldest-loaded history cursor per channel (for "load older" backward paging). */
  olderCursors: Record<string, string | null>;
  /** Reaction aggregation: channelId → messageId → key → ReactionGroup. */
  reactions: Record<string, Record<string, Record<string, ReactionGroup>>>;
  /** Typing actors per channel id (excludes self; cleared on stop/timeout). */
  typing: Record<string, string[]>;
}

const [chat, setChat] = createStore<ChatState>({
  channels: {},
  messages: {},
  cursors: {},
  olderCursors: {},
  reactions: {},
  typing: {},
});

export { chat };

export function upsertChannel(channel: ChannelSummary): void {
  setChat("channels", channel.id, (prev) => ({ ...prev, ...channel }));
}

/**
 * The {@link ChatMessage} fields a message version owns (§5.3). A merge of the
 * same version or a newer one removes each one the copy lacks, so an edit that
 * drops an article's `title` or `cover` (or a reply `reference`, `tags`…)
 * clears it; an older copy leaves them all as stored ({@link mergeCanonical}).
 * `deletedAt` is not listed: the shared merge treats a tombstone as terminal,
 * so no copy un-deletes a message. `cursor`, `clientMessageId`, `pending` and
 * `failed` are local bookkeeping, kept when a copy omits them. So is
 * `replyCount`: it is advisory listing metadata a history page stamps (§7.2),
 * not a field of the message, and `message.updated` never carries it, so a
 * live edit keeps the stored count while a copy that has one replaces it.
 */
const VERSION_KEYS = [
  "content",
  "type",
  "attachments",
  "reference",
  "tags",
  "title",
  "summary",
  "cover",
  "createdAt",
  "editedAt",
] as const satisfies readonly (keyof ChatMessage)[];

/**
 * Merge a newer copy of a message into the stored one, IN PLACE. The stored
 * object's identity is what `<For>` keys a rendered row on, so keeping it keeps
 * the row and its UI state (an open lightbox, an edit in progress) alive when
 * the optimistic echo reconciles or the message is updated. Replacing the
 * object re-created the row mid-interaction: a lightbox opened on the echo
 * vanished when the canonical copy landed. The stored copy then mirrors a
 * same-or-newer copy for every version field, and an older copy (a stale
 * history page) cannot undo an edit or a delete ({@link mergeCanonical}).
 */
function mergeMessage(target: ChatMessage | undefined, patch: ChatMessage): void {
  if (target !== undefined) mergeCanonical(target, patch, VERSION_KEYS);
}

/**
 * Append or replace a message in a channel timeline. De-dupes by `id`, and — when
 * the message carries a `clientMessageId` — reconciles a matching optimistic echo
 * (replacing it in place so the local copy becomes canonical, no duplicate).
 * The echo matches only when both the `clientMessageId` and the `author` are the
 * same: the key is idempotent per author (§7.1), so another author's message may
 * reuse it and must not consume our pending send.
 */
export function upsertMessage(channelId: string, message: ChatMessage): void {
  setChat(
    produce((s) => {
      if (!s.messages[channelId]) s.messages[channelId] = [];
      const list = s.messages[channelId];

      // 1) Reconcile an optimistic echo by clientMessageId.
      if (message.clientMessageId) {
        const echoIdx = list.findIndex(
          (m) =>
            m.pending &&
            m.clientMessageId === message.clientMessageId &&
            m.author === message.author,
        );
        if (echoIdx !== -1) {
          mergeMessage(list[echoIdx], { ...message, pending: false, failed: false });
          if (message.cursor && cursorAdvances(s.cursors[channelId], message.cursor)) {
            s.cursors[channelId] = message.cursor;
          }
          return;
        }
      }

      // 2) De-dupe by canonical id.
      const idx = list.findIndex((m) => m.id === message.id);
      if (idx === -1) list.push(message);
      else mergeMessage(list[idx], message);

      if (message.cursor && cursorAdvances(s.cursors[channelId], message.cursor)) {
        s.cursors[channelId] = message.cursor;
      }
    }),
  );
}

/**
 * Reconcile a pending optimistic echo with its canonical `message.created`,
 * matched by the local `clientMessageId` (the controller maps a send's WS
 * `correlationId` → `clientMessageId`, since the server's canonical payload does
 * NOT echo `clientMessageId`). Replaces the echo in place; if no echo is found
 * (e.g. it already reconciled, or another tab) falls back to a plain id upsert so
 * the message still lands exactly once.
 */
export function reconcileOptimistic(
  channelId: string,
  clientMessageId: string,
  message: ChatMessage,
): void {
  setChat(
    produce((s) => {
      if (!s.messages[channelId]) s.messages[channelId] = [];
      const list = s.messages[channelId];
      const echoIdx = list.findIndex(
        (m) => (m.pending || m.failed) && m.clientMessageId === clientMessageId,
      );
      // Also de-dupe against an already-present canonical copy (live fan-out may
      // have raced the author's correlated copy).
      const dupeIdx = list.findIndex((m) => m.id === message.id);
      if (echoIdx !== -1) {
        if (dupeIdx !== -1 && dupeIdx !== echoIdx) list.splice(dupeIdx, 1);
        const at = list.findIndex(
          (m) => (m.pending || m.failed) && m.clientMessageId === clientMessageId,
        );
        if (at !== -1) {
          mergeMessage(list[at], { ...message, pending: false, failed: false });
        }
      } else if (dupeIdx === -1) {
        list.push({ ...message, pending: false, failed: false });
      } else {
        mergeMessage(list[dupeIdx], message);
      }
      if (message.cursor && cursorAdvances(s.cursors[channelId], message.cursor)) {
        s.cursors[channelId] = message.cursor;
      }
    }),
  );
}

/**
 * Prepend a page of OLDER history (backward paging), `older` given OLDEST-FIRST.
 *
 * Position, not sorting, is what makes this correct: a backward page's keyset is
 * exclusive, so every message in it is strictly older (lower `seq`) than
 * everything already loaded — inserting the page at the FRONT, in order, keeps
 * the timeline chronological without re-sorting rows whose cursors we'd have to
 * compare (optimistic echoes carry no cursor at all). Items already present are
 * merged in place instead (a re-fetched overlap must not duplicate).
 *
 * The newest-cursor (`cursors`, the WS resume `since`) is deliberately NOT
 * touched: older history can never advance it.
 */
export function prependHistory(channelId: string, older: ChatMessage[]): void {
  setChat(
    produce((s) => {
      if (!s.messages[channelId]) s.messages[channelId] = [];
      const list = s.messages[channelId];
      const fresh: ChatMessage[] = [];
      for (const m of older) {
        const idx = list.findIndex((x) => x.id === m.id);
        if (idx === -1) fresh.push(m);
        else mergeMessage(list[idx], m);
      }
      list.unshift(...fresh);
    }),
  );
}

/**
 * Record the channel's OLDER-history cursor: the cursor the next backward page
 * continues from, or `null` once the channel is fully paged back. The chat UI
 * gates its "Load older messages" affordance on this, so the controller MUST
 * publish it after the initial history page and after every `loadOlder()`.
 */
export function setOlderCursor(channelId: string, cursor: string | null): void {
  setChat("olderCursors", channelId, cursor);
}

/** Add a local optimistic echo for a just-sent message. */
export function addOptimistic(channelId: string, message: ChatMessage): void {
  setChat(
    produce((s) => {
      if (!s.messages[channelId]) s.messages[channelId] = [];
      s.messages[channelId].push({ ...message, pending: true });
    }),
  );
}

/** Mark an optimistic echo as failed (send error) so the UI can offer a retry. */
export function markOptimisticFailed(channelId: string, clientMessageId: string): void {
  setChat(
    produce((s) => {
      const m = s.messages[channelId]?.find(
        (x) => x.pending && x.clientMessageId === clientMessageId,
      );
      if (m) {
        m.pending = false;
        m.failed = true;
      }
    }),
  );
}

/** Drop an optimistic echo entirely (e.g. on retry-resend before re-adding). */
export function dropOptimistic(channelId: string, clientMessageId: string): void {
  setChat(
    produce((s) => {
      const list = s.messages[channelId];
      if (!list) return;
      const idx = list.findIndex(
        (x) => x.clientMessageId === clientMessageId && (x.pending || x.failed),
      );
      if (idx !== -1) list.splice(idx, 1);
    }),
  );
}

/** Apply an in-place edit (set new content + editedAt), de-duped by id. */
export function applyEdit(channelId: string, message: ChatMessage): void {
  upsertMessage(channelId, message);
}

/** Mark a message tombstoned (clear content, set deletedAt), preserving position. */
export function tombstoneMessage(channelId: string, messageId: string, deletedAt: string): void {
  setChat(
    produce((s) => {
      const list = s.messages[channelId];
      const msg = list?.find((m) => m.id === messageId);
      if (msg) {
        msg.deletedAt = deletedAt;
        msg.content = { mime: "text/plain", text: "" };
        msg.attachments = [];
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Reactions (client-side aggregation)
// ---------------------------------------------------------------------------

/** Fold a `Reaction` (from a `reaction.added` event or the history endpoint). */
export function addReactionAgg(channelId: string, reaction: Reaction): void {
  const messageId = reaction.reference.id;
  setChat(
    produce((s) => {
      if (!s.reactions[channelId]) s.reactions[channelId] = {};
      const byMsg = s.reactions[channelId];
      if (!byMsg[messageId]) byMsg[messageId] = {};
      const byKey = byMsg[messageId];
      const group: ReactionGroup = byKey[reaction.key] ?? {
        key: reaction.key,
        ...(reaction.unicode !== undefined ? { unicode: reaction.unicode } : {}),
        ...(reaction.image !== undefined ? { image: reaction.image } : {}),
        authors: [],
      };
      byKey[reaction.key] = group;
      if (reaction.unicode !== undefined) group.unicode = reaction.unicode;
      if (reaction.image !== undefined) group.image = reaction.image;
      if (!group.authors.includes(reaction.author)) group.authors.push(reaction.author);
    }),
  );
}

/** Remove an actor's reaction `key` from a message (folds a `reaction.removed`). */
export function removeReactionAgg(
  channelId: string,
  messageId: string,
  key: string,
  author: string,
): void {
  setChat(
    produce((s) => {
      const byMsg = s.reactions[channelId]?.[messageId];
      const group = byMsg?.[key];
      if (!byMsg || !group) return;
      const idx = group.authors.indexOf(author);
      if (idx !== -1) group.authors.splice(idx, 1);
      if (group.authors.length === 0) delete byMsg[key];
    }),
  );
}

/** Aggregated reaction groups for a message (non-empty groups only). */
export function reactionsFor(channelId: string, messageId: string): ReactionGroup[] {
  const byKey = chat.reactions[channelId]?.[messageId];
  if (!byKey) return [];
  return Object.values(byKey).filter((g) => g.authors.length > 0);
}

// ---------------------------------------------------------------------------
// Typing indicators
// ---------------------------------------------------------------------------

/** Add/remove a typing actor for a channel (self is filtered by the caller). */
export function setTyping(channelId: string, actor: string, typing: boolean): void {
  setChat(
    produce((s) => {
      if (!s.typing[channelId]) s.typing[channelId] = [];
      const list = s.typing[channelId];
      const idx = list.indexOf(actor);
      if (typing && idx === -1) list.push(actor);
      else if (!typing && idx !== -1) list.splice(idx, 1);
    }),
  );
}

export function typingFor(channelId: string): string[] {
  return chat.typing[channelId] ?? [];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function messagesFor(channelId: string): ChatMessage[] {
  return chat.messages[channelId] ?? [];
}

export function cursorFor(channelId: string): string | undefined {
  return chat.cursors[channelId];
}

export function olderCursorFor(channelId: string): string | null | undefined {
  return chat.olderCursors[channelId];
}

/** Reset all chat state (logout). */
export function clearChat(): void {
  setChat({
    channels: {},
    messages: {},
    cursors: {},
    olderCursors: {},
    reactions: {},
    typing: {},
  });
}
