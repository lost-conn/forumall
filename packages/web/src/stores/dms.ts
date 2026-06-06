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
import { createStore, produce } from "solid-js/store";

/** A DM message as the thread renders it (received OR locally-retained sent). */
export interface DmMessage {
  /** Canonical server id, OR a temporary `optimistic:<clientMessageId>` id. */
  id: string;
  author: string;
  content: { mime?: string; text?: string };
  createdAt: string;
  /** Set on a local echo until its canonical confirmation replaces it. */
  clientMessageId?: string;
  /** True for the caller's own (sent) messages; false for received ones. */
  mine?: boolean;
  /** Optimistic-echo lifecycle: pending → confirmed (replaced) | failed. */
  pending?: boolean;
  failed?: boolean;
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
}

const [dms, setDms] = createStore<DmState>({
  conversations: {},
  threads: {},
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The merged (received + sent) timeline for a conversation, ascending. */
export function dmThread(dmId: string): DmMessage[] {
  return dms.threads[dmId] ?? [];
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
  setDms({ conversations: {}, threads: {} });
}
