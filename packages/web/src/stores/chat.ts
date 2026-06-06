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

/** A message as the client cares about it (superset of the WS payload). */
export interface ChatMessage {
  /** Canonical server id, OR a temporary `optimistic:<clientMessageId>` id. */
  id: string;
  author: string;
  /** §5.3 message type: message | memo | article | (unknown → text fallback). */
  type?: string;
  content: { mime?: string; text?: string };
  attachments?: Attachment[];
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
  /** Latest resume cursor seen per channel id (newest loaded). */
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

/** Compare two cursors as opaque base-comparable strings (history is seq-ordered). */
function cursorLess(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined) return true;
  if (b === undefined) return false;
  // Cursors share one ordered space; longer-then-lexical compares the encoded seq.
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

/**
 * Append or replace a message in a channel timeline. De-dupes by `id`, and — when
 * the message carries a `clientMessageId` — reconciles a matching optimistic echo
 * (replacing it in place so the local copy becomes canonical, no duplicate).
 */
export function upsertMessage(channelId: string, message: ChatMessage): void {
  setChat(
    produce((s) => {
      if (!s.messages[channelId]) s.messages[channelId] = [];
      const list = s.messages[channelId];

      // 1) Reconcile an optimistic echo by clientMessageId.
      if (message.clientMessageId) {
        const echoIdx = list.findIndex(
          (m) => m.pending && m.clientMessageId === message.clientMessageId,
        );
        if (echoIdx !== -1) {
          list[echoIdx] = { ...list[echoIdx], ...message, pending: false, failed: false };
          if (message.cursor && cursorLess(s.cursors[channelId], message.cursor)) {
            s.cursors[channelId] = message.cursor;
          }
          return;
        }
      }

      // 2) De-dupe by canonical id.
      const idx = list.findIndex((m) => m.id === message.id);
      if (idx === -1) list.push(message);
      else list[idx] = { ...list[idx], ...message };

      if (message.cursor && cursorLess(s.cursors[channelId], message.cursor)) {
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
          list[at] = { ...list[at], ...message, pending: false, failed: false };
        }
      } else if (dupeIdx === -1) {
        list.push({ ...message, pending: false, failed: false });
      } else {
        list[dupeIdx] = { ...list[dupeIdx], ...message };
      }
      if (message.cursor && cursorLess(s.cursors[channelId], message.cursor)) {
        s.cursors[channelId] = message.cursor;
      }
    }),
  );
}

/**
 * Prepend a page of OLDER history (backward paging). Each item is de-duped by id;
 * the merged list is re-sorted by cursor so order is stable regardless of arrival.
 */
export function prependHistory(
  channelId: string,
  older: ChatMessage[],
  nextOlderCursor: string | null,
): void {
  setChat(
    produce((s) => {
      if (!s.messages[channelId]) s.messages[channelId] = [];
      const list = s.messages[channelId];
      for (const m of older) {
        const idx = list.findIndex((x) => x.id === m.id);
        if (idx === -1) list.push(m);
        else list[idx] = { ...list[idx], ...m };
      }
      // Stable order: by cursor when present (seq order), else keep arrival order.
      list.sort((a, b) => {
        if (a.cursor && b.cursor) return cursorLess(a.cursor, b.cursor) ? -1 : 1;
        return 0;
      });
      s.olderCursors[channelId] = nextOlderCursor;
      // Track the newest cursor so the WS resume `since` is correct.
      for (const m of older) {
        if (m.cursor && cursorLess(s.cursors[channelId], m.cursor)) {
          s.cursors[channelId] = m.cursor;
        }
      }
    }),
  );
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
