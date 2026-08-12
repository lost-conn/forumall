/**
 * Direct-messages store (P8 DMs UI). Holds the per-conversation timeline the DM
 * thread renders, keyed by `dmId`, plus a lightweight conversation index for the
 * sidebar list.
 *
 * ## The §8.3 reconciliation this store performs
 * A DM thread is the MERGE of two sources with disjoint authorship:
 *   - RECEIVED messages — the caller's inbox copies from the server
 *     (`GET /api/dms/{dmId}/messages` + live `dm.message` WS events). The caller
 *     never authored these.
 *   - SENT messages — the caller's OWN messages, retained locally
 *     (`lib/dm-store.ts`), because the server keeps no sender copy.
 * Both are folded into one timeline here, ordered by `createdAt`, de-duped by
 * `id`. An optimistic local echo (a just-sent message before its POST confirms)
 * is keyed by `clientMessageId` and reconciled in place when the canonical
 * message lands — mirroring the chat store's optimistic-echo contract.
 *
 * The store is transport-agnostic: the DM controller feeds received messages
 * (REST history + WS) and the sent-store hydrate/echo here.
 */
import type { Attachment, Reaction } from "@forumall/shared";
import { createStore, produce } from "solid-js/store";

/** A DM message as the thread renders it (received OR locally-retained sent). */
export interface DmMessage {
  /** Canonical server id, OR a temporary `optimistic:<clientMessageId>` id. */
  id: string;
  author: string;
  content: { mime?: string; text?: string };
  /** Media attachments carried on the message (parity with channel messages). */
  attachments?: Attachment[];
  /** §5.3 reply pointer: `{ type: "reply", id: <parent message id> }`. */
  reference?: { type: string; id: string };
  createdAt: string;
  /** Set when the message was edited in place. */
  editedAt?: string;
  /** Set when the message was tombstoned (deleted). */
  deletedAt?: string;
  /** Set on a local echo until its canonical confirmation replaces it. */
  clientMessageId?: string;
  /** Opaque timeline cursor (§7.2/§7.4 share one space); decodes to `seq`. */
  cursor?: string;
  /** True for the caller's own (sent) messages; false for received ones. */
  mine?: boolean;
  /** Optimistic-echo lifecycle: pending → confirmed (replaced) | failed. */
  pending?: boolean;
  failed?: boolean;
}

/** Aggregated reactions for one DM message: key → { unicode, authors }. */
export interface DmReactionGroup {
  key: string;
  unicode?: string;
  image?: string;
  authors: string[];
}

/** A conversation summary for the sidebar list. */
export interface DmConversationSummary {
  dmId: string;
  /** The other participant `handle@domain`. */
  counterparty: string;
  /** Preview text of the most recent message in the thread (sent or received). */
  lastMessageText?: string;
  /** ISO timestamp used to sort the list (most-recent activity first). */
  updatedAt?: string;
}

interface DmState {
  /** Conversation index by dmId (merge of server list + locally-known). */
  conversations: Record<string, DmConversationSummary>;
  /** Merged message timeline per dmId (ascending by createdAt). */
  threads: Record<string, DmMessage[]>;
  /** Reaction aggregation: dmId → messageId → key → DmReactionGroup. */
  reactions: Record<string, Record<string, Record<string, DmReactionGroup>>>;
  /** Typing actors per dmId (the counterparty; cleared on stop/timeout). */
  typing: Record<string, string[]>;
  /**
   * Oldest-loaded inbox cursor per dmId — what the next BACKWARD page continues
   * from, `null` once the inbox side is fully paged back.
   */
  olderCursors: Record<string, string | null>;
  /**
   * Whether ANY older history remains for a dmId. Not the same as
   * `olderCursors`: a thread's older window can also live purely in the local
   * sent-store (§8.3 — the caller's own messages have no server copy), so the
   * inbox cursor can be `null` while there is still backlog to reveal. The UI
   * gates its "Load older messages" affordance on THIS.
   */
  hasOlder: Record<string, boolean>;
}

const [dms, setDms] = createStore<DmState>({
  conversations: {},
  threads: {},
  reactions: {},
  typing: {},
  olderCursors: {},
  hasOlder: {},
});

export { dms };

/** Stable ascending order by `createdAt`, breaking ties by `id`. */
function compareMessages(a: DmMessage, b: DmMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold one message into a conversation thread, de-duped by `id` and — when it
 * carries a `clientMessageId` — reconciling a matching optimistic echo in place
 * (so a confirmed send replaces its local echo rather than duplicating). The
 * merged list is re-sorted by `createdAt` so received + sent interleave
 * correctly regardless of arrival order.
 */
export function upsertDmMessage(dmId: string, message: DmMessage): void {
  setDms(
    produce((s) => {
      if (!s.threads[dmId]) s.threads[dmId] = [];
      const list = s.threads[dmId];

      // 1) Reconcile an optimistic echo by clientMessageId.
      if (message.clientMessageId) {
        const echoIdx = list.findIndex(
          (m) => (m.pending || m.failed) && m.clientMessageId === message.clientMessageId,
        );
        if (echoIdx !== -1) {
          // Also drop any canonical dupe that raced ahead of the confirmation.
          const dupeIdx = list.findIndex((m) => m.id === message.id && m !== list[echoIdx]);
          if (dupeIdx !== -1) list.splice(dupeIdx, 1);
          const at = list.findIndex(
            (m) => (m.pending || m.failed) && m.clientMessageId === message.clientMessageId,
          );
          if (at !== -1) {
            list[at] = { ...list[at], ...message, pending: false, failed: false };
          }
          list.sort(compareMessages);
          return;
        }
      }

      // 2) De-dupe by canonical id.
      const idx = list.findIndex((m) => m.id === message.id);
      if (idx === -1) list.push(message);
      else list[idx] = { ...list[idx], ...message };
      list.sort(compareMessages);
    }),
  );
}

/** Add a local optimistic echo for a just-sent DM (pending until confirmed). */
export function addDmOptimistic(dmId: string, message: DmMessage): void {
  setDms(
    produce((s) => {
      if (!s.threads[dmId]) s.threads[dmId] = [];
      s.threads[dmId].push({ ...message, mine: true, pending: true });
      s.threads[dmId].sort(compareMessages);
    }),
  );
}

/** Mark an optimistic echo failed (send error) so the UI can offer a retry. */
export function markDmFailed(dmId: string, clientMessageId: string): void {
  setDms(
    produce((s) => {
      const m = s.threads[dmId]?.find((x) => x.pending && x.clientMessageId === clientMessageId);
      if (m) {
        m.pending = false;
        m.failed = true;
      }
    }),
  );
}

/** Drop an optimistic echo entirely (e.g. before a retry re-adds it). */
export function dropDmOptimistic(dmId: string, clientMessageId: string): void {
  setDms(
    produce((s) => {
      const list = s.threads[dmId];
      if (!list) return;
      const idx = list.findIndex(
        (x) => x.clientMessageId === clientMessageId && (x.pending || x.failed),
      );
      if (idx !== -1) list.splice(idx, 1);
    }),
  );
}

/** Insert or update a conversation summary, keeping the newest `updatedAt`. */
export function upsertConversation(summary: DmConversationSummary): void {
  setDms(
    produce((s) => {
      const prev = s.conversations[summary.dmId];
      if (!prev) {
        s.conversations[summary.dmId] = summary;
        return;
      }
      // Keep the most-recent activity + any non-empty preview.
      const merged: DmConversationSummary = { ...prev, ...summary };
      if (prev.updatedAt && (!summary.updatedAt || summary.updatedAt < prev.updatedAt)) {
        merged.updatedAt = prev.updatedAt;
        merged.lastMessageText = prev.lastMessageText;
      }
      s.conversations[summary.dmId] = merged;
    }),
  );
}

/**
 * Apply an in-place edit to a DM message (new content + `editedAt`), de-duped by
 * id. Edits arrive as a `dm.message` event carrying the new content + `editedAt`
 * (the server re-fans the stored copy), so this is just an id-keyed upsert.
 */
export function applyDmEdit(dmId: string, message: DmMessage): void {
  upsertDmMessage(dmId, message);
}

/** The pre-mutation snapshot {@link restoreDmMessage} rewinds a message to. */
export interface DmMessageRestore {
  id: string;
  content: { mime?: string; text?: string };
  attachments?: Attachment[];
  reference?: { type: string; id: string };
  /**
   * The `editedAt` the message carried BEFORE the reverted mutation — omitted
   * when it had never been edited, in which case the marker is REMOVED.
   */
  editedAt?: string;
}

/**
 * Rewind a message to its pre-mutation snapshot — the un-do for an optimistic
 * {@link applyDmEdit} / {@link tombstoneDmMessage} that the server rejected.
 *
 * This is NOT expressible as an upsert: {@link upsertDmMessage} MERGES
 * (`{...existing, ...incoming}`), so a snapshot without `editedAt`/`deletedAt`
 * leaves the old markers in place and the message renders "(edited)" (or stays a
 * tombstone) while showing the pre-edit text. The row is therefore REBUILT from
 * the snapshot: the mutation-owned fields (`content`, `attachments`, `reference`,
 * `editedAt`, `deletedAt`) are re-derived and simply absent when the snapshot has
 * none, while identity + placement (`author`, `createdAt`, `cursor`, `mine`, echo
 * state) are carried over so the message keeps its position and echo linkage.
 * A no-op when the message is not loaded in this thread.
 */
export function restoreDmMessage(dmId: string, prior: DmMessageRestore): void {
  setDms(
    produce((s) => {
      const list = s.threads[dmId];
      const idx = list?.findIndex((m) => m.id === prior.id) ?? -1;
      if (!list || idx === -1) return;
      const existing = list[idx] as DmMessage;
      list[idx] = {
        id: existing.id,
        author: existing.author,
        createdAt: existing.createdAt,
        content: prior.content,
        ...(prior.attachments && prior.attachments.length > 0
          ? { attachments: prior.attachments }
          : {}),
        ...(prior.reference ? { reference: prior.reference } : {}),
        ...(prior.editedAt !== undefined ? { editedAt: prior.editedAt } : {}),
        ...(existing.clientMessageId !== undefined
          ? { clientMessageId: existing.clientMessageId }
          : {}),
        ...(existing.cursor !== undefined ? { cursor: existing.cursor } : {}),
        ...(existing.mine !== undefined ? { mine: existing.mine } : {}),
        ...(existing.pending !== undefined ? { pending: existing.pending } : {}),
        ...(existing.failed !== undefined ? { failed: existing.failed } : {}),
      };
    }),
  );
}

/**
 * Mark a DM message tombstoned (clear content + attachments, set `deletedAt`),
 * preserving its position in the timeline — mirrors the chat store's
 * `tombstoneMessage`. A delete arrives as a `dm.message` event with `deletedAt`.
 */
export function tombstoneDmMessage(dmId: string, messageId: string, deletedAt: string): void {
  setDms(
    produce((s) => {
      const msg = s.threads[dmId]?.find((m) => m.id === messageId);
      if (msg) {
        msg.deletedAt = deletedAt;
        msg.content = { mime: "text/plain", text: "" };
        msg.attachments = [];
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Reactions (client-side aggregation — mirrors the chat store)
// ---------------------------------------------------------------------------

/** Fold a `Reaction` (from a `dm.reaction` added event or the history embed). */
export function addDmReactionAgg(dmId: string, reaction: Reaction): void {
  const messageId = reaction.reference.id;
  setDms(
    produce((s) => {
      if (!s.reactions[dmId]) s.reactions[dmId] = {};
      const byMsg = s.reactions[dmId];
      if (!byMsg[messageId]) byMsg[messageId] = {};
      const byKey = byMsg[messageId];
      const group: DmReactionGroup = byKey[reaction.key] ?? {
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

/** Remove an actor's reaction `key` from a DM message (folds `dm.reaction` removed). */
export function removeDmReactionAgg(
  dmId: string,
  messageId: string,
  key: string,
  author: string,
): void {
  setDms(
    produce((s) => {
      const byMsg = s.reactions[dmId]?.[messageId];
      const group = byMsg?.[key];
      if (!byMsg || !group) return;
      const idx = group.authors.indexOf(author);
      if (idx !== -1) group.authors.splice(idx, 1);
      if (group.authors.length === 0) delete byMsg[key];
    }),
  );
}

/** Aggregated reaction groups for a DM message (non-empty groups only). */
export function dmReactionsFor(dmId: string, messageId: string): DmReactionGroup[] {
  const byKey = dms.reactions[dmId]?.[messageId];
  if (!byKey) return [];
  return Object.values(byKey).filter((g) => g.authors.length > 0);
}

// ---------------------------------------------------------------------------
// Typing indicators
// ---------------------------------------------------------------------------

/** Add/remove a typing actor for a DM (the caller filters self). */
export function setDmTyping(dmId: string, actor: string, typing: boolean): void {
  setDms(
    produce((s) => {
      if (!s.typing[dmId]) s.typing[dmId] = [];
      const list = s.typing[dmId];
      const idx = list.indexOf(actor);
      if (typing && idx === -1) list.push(actor);
      else if (!typing && idx !== -1) list.splice(idx, 1);
    }),
  );
}

export function dmTypingFor(dmId: string): string[] {
  return dms.typing[dmId] ?? [];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The merged (received + sent) timeline for a conversation, ascending. */
export function dmThread(dmId: string): DmMessage[] {
  return dms.threads[dmId] ?? [];
}

/**
 * Record a conversation's older-history state: the inbox cursor the next
 * backward page continues from (`null` when the inbox is exhausted) and whether
 * any older history remains at all (inbox page OR local sent backlog). The DM
 * controller publishes both after the initial page and after every `loadOlder()`.
 */
export function setDmOlderCursor(dmId: string, cursor: string | null, hasOlder: boolean): void {
  setDms(
    produce((s) => {
      s.olderCursors[dmId] = cursor;
      s.hasOlder[dmId] = hasOlder;
    }),
  );
}

/** The next backward-page cursor for a conversation's inbox, if any. */
export function dmOlderCursorFor(dmId: string): string | null | undefined {
  return dms.olderCursors[dmId];
}

/** Whether older history remains for a conversation (inbox page or sent backlog). */
export function dmHasOlder(dmId: string): boolean {
  return dms.hasOlder[dmId] === true;
}

/** All known conversations, newest-activity first. */
export function dmConversations(): DmConversationSummary[] {
  return Object.values(dms.conversations).sort((a, b) => {
    const at = a.updatedAt ?? "";
    const bt = b.updatedAt ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.dmId < b.dmId ? -1 : 1;
  });
}

/** Reset all DM state (logout / account switch). */
export function clearDms(): void {
  setDms({
    conversations: {},
    threads: {},
    reactions: {},
    typing: {},
    olderCursors: {},
    hasOlder: {},
  });
}
