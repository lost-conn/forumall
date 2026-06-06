/**
 * Local sent-message store for direct messages (spec §7.4, §8.3).
 *
 * ## Why this exists (the key §8.3 invariant)
 * A DM is stored ONLY in the recipient's inbox on the recipient's home provider.
 * There is NO sender copy: `GET /api/dms/{dmId}/messages` returns the caller's
 * RECEIVED messages only. So for the sender to see their own thread history —
 * and to keep seeing it across reloads — the client MUST retain every message it
 * SENDS locally. This module is that retention layer.
 *
 * ## Shape + keying
 * Persisted per CURRENT USER (so two accounts in the same browser don't bleed),
 * keyed by `dmId`, an append-only list of the canonical sent messages this user
 * authored in that conversation. The thread view merges these with the server's
 * received messages, ordered by `createdAt`, de-duped by `id`.
 *
 * ## Backing store
 * `localStorage` when available (synchronous, survives reload — all we need for a
 * small text log), with an in-memory fallback (SSR / tests / private-mode). The
 * surface is intentionally tiny + synchronous so the DM store/controller stay
 * simple; a future migration to IndexedDB (mirroring `key-store.ts`) can swap the
 * backend without touching callers.
 */

/** A locally-retained sent DM message (a subset of the canonical §5.3 Message). */
export interface SentDmMessage {
  /** Canonical server id (`msg_…`) once the POST confirms; never the optimistic id. */
  id: string;
  /** The sending actor (always the current user). */
  author: string;
  content: { mime?: string; text?: string };
  createdAt: string;
  /** Echoed so a live `dm.message` (foreign tab) can de-dupe against the local copy. */
  clientMessageId?: string;
}

/** The synchronous persistence surface every backend implements. */
interface SentStoreBackend {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
  /** All keys currently held (for a full wipe on logout). */
  keys(): string[];
}

const STORAGE_PREFIX = "forumall:dm-sent:";

function backend(): SentStoreBackend {
  if (typeof localStorage !== "undefined") {
    return {
      read: (k) => localStorage.getItem(k),
      write: (k, v) => localStorage.setItem(k, v),
      remove: (k) => localStorage.removeItem(k),
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) out.push(k);
        }
        return out;
      },
    };
  }
  const mem = new Map<string, string>();
  return {
    read: (k) => mem.get(k) ?? null,
    write: (k, v) => {
      mem.set(k, v);
    },
    remove: (k) => {
      mem.delete(k);
    },
    keys: () => [...mem.keys()],
  };
}

/**
 * The local sent-store, scoped to one current user. Construct with the
 * authenticated actor so entries are namespaced per account.
 */
export class DmSentStore {
  private readonly store: SentStoreBackend;
  private readonly userKey: string;

  constructor(currentActor: string, store: SentStoreBackend = backend()) {
    this.store = store;
    // Namespace by the current user so multiple accounts in one browser stay
    // isolated. The actor is opaque; encode it so a `:` in it can't collide.
    this.userKey = encodeURIComponent(currentActor);
  }

  private storageKey(dmId: string): string {
    return `${STORAGE_PREFIX}${this.userKey}:${dmId}`;
  }

  /** All sent messages this user retained for `dmId` (ascending by createdAt). */
  list(dmId: string): SentDmMessage[] {
    const raw = this.store.read(this.storageKey(dmId));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as SentDmMessage[];
      if (!Array.isArray(parsed)) return [];
      return [...parsed].sort(compareByCreatedAt);
    } catch {
      return [];
    }
  }

  /**
   * Persist a message this user SENT in `dmId`. De-duped by `id` (a re-send /
   * idempotent retry replaces in place) and, when present, by `clientMessageId`
   * so an optimistic add followed by the canonical confirmation collapses to one
   * entry rather than duplicating.
   */
  append(dmId: string, message: SentDmMessage): void {
    const list = this.list(dmId);
    const idx = list.findIndex(
      (m) =>
        m.id === message.id ||
        (message.clientMessageId !== undefined && m.clientMessageId === message.clientMessageId),
    );
    if (idx === -1) list.push(message);
    else list[idx] = { ...list[idx], ...message };
    list.sort(compareByCreatedAt);
    this.store.write(this.storageKey(dmId), JSON.stringify(list));
  }

  /** Every dmId this user has locally-retained sent messages for. */
  knownDmIds(): string[] {
    const prefix = `${STORAGE_PREFIX}${this.userKey}:`;
    return this.store
      .keys()
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .filter((id) => id.startsWith("dm_"));
  }

  /**
   * Remember the counterparty for a `dmId` (so a conversation this user has only
   * SENT to — with no inbox row on the server, hence absent from `GET /api/me/dms`
   * — still shows the participant in the list). `deriveDmId` is one-way, so the
   * counterparty can't be recovered from the id alone; we persist it here.
   */
  rememberCounterparty(dmId: string, counterparty: string): void {
    const map = this.counterpartyMap();
    if (map[dmId] === counterparty) return;
    map[dmId] = counterparty;
    this.store.write(this.metaKey(), JSON.stringify(map));
  }

  /** The remembered counterparty for `dmId`, or null. */
  counterpartyFor(dmId: string): string | null {
    return this.counterpartyMap()[dmId] ?? null;
  }

  private metaKey(): string {
    return `${STORAGE_PREFIX}${this.userKey}:__meta_counterparties`;
  }

  private counterpartyMap(): Record<string, string> {
    const raw = this.store.read(this.metaKey());
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Wipe every retained sent message + counterparty meta for THIS user. */
  clear(): void {
    const prefix = `${STORAGE_PREFIX}${this.userKey}:`;
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.remove(k);
    }
  }
}

/** Stable ascending order by `createdAt`, breaking ties by `id`. */
function compareByCreatedAt(a: SentDmMessage, b: SentDmMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
