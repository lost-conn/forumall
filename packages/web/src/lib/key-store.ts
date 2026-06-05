/**
 * Device private-key storage (P8 client foundation).
 *
 * An OFSCP device key is an Ed25519 private seed (base64 of the raw 32 bytes,
 * the shape `@forumall/shared`'s `sign`/`signWsAuthenticate` accept). It is the
 * device's long-lived credential: it MUST persist across reloads but MUST NOT
 * leave the device. This module is a small async abstraction over that storage
 * so the rest of the client never touches the persistence layer directly.
 *
 * Backing store: IndexedDB when available (browser), with an in-memory fallback
 * (SSR / tests / private-mode failures). The auth card hardens this further
 * (e.g. non-extractable WebCrypto keys); for now the contract is just:
 *
 *   getKey(keyId)        -> base64 private seed | null
 *   setKey(keyId, seed)  -> persist
 *   clear()              -> wipe all stored keys (logout)
 *   listKeyIds()         -> known key ids
 *
 * Keys are stored under their server-assigned `keyId` so a device can hold more
 * than one registered key.
 */

/** A stored device key: the server `keyId` plus the base64 private seed. */
export interface StoredDeviceKey {
  keyId: string;
  /** Base64 of the raw 32-byte Ed25519 private seed. */
  privateKey: string;
}

/** The async key-store contract every backend implements. */
export interface KeyStore {
  getKey(keyId: string): Promise<string | null>;
  setKey(keyId: string, privateKey: string): Promise<void>;
  /** All stored entries (e.g. to pick a default signing key). */
  list(): Promise<StoredDeviceKey[]>;
  listKeyIds(): Promise<string[]>;
  remove(keyId: string): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "forumall";
const STORE = "device-keys";
const DB_VERSION = 1;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "keyId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/** IndexedDB-backed key store. Used in the browser. */
class IndexedDbKeyStore implements KeyStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb();
    return this.dbPromise;
  }

  async getKey(keyId: string): Promise<string | null> {
    const db = await this.db();
    const row = await tx<StoredDeviceKey | undefined>(db, "readonly", (s) => s.get(keyId));
    return row?.privateKey ?? null;
  }

  async setKey(keyId: string, privateKey: string): Promise<void> {
    const db = await this.db();
    await tx(db, "readwrite", (s) => s.put({ keyId, privateKey } satisfies StoredDeviceKey));
  }

  async list(): Promise<StoredDeviceKey[]> {
    const db = await this.db();
    return (await tx<StoredDeviceKey[]>(db, "readonly", (s) => s.getAll())) ?? [];
  }

  async listKeyIds(): Promise<string[]> {
    return (await this.list()).map((k) => k.keyId);
  }

  async remove(keyId: string): Promise<void> {
    const db = await this.db();
    await tx(db, "readwrite", (s) => s.delete(keyId));
  }

  async clear(): Promise<void> {
    const db = await this.db();
    await tx(db, "readwrite", (s) => s.clear());
  }
}

/** In-memory key store. SSR / tests / IndexedDB-unavailable fallback. */
export class MemoryKeyStore implements KeyStore {
  private readonly map = new Map<string, string>();

  getKey(keyId: string): Promise<string | null> {
    return Promise.resolve(this.map.get(keyId) ?? null);
  }
  setKey(keyId: string, privateKey: string): Promise<void> {
    this.map.set(keyId, privateKey);
    return Promise.resolve();
  }
  list(): Promise<StoredDeviceKey[]> {
    return Promise.resolve([...this.map].map(([keyId, privateKey]) => ({ keyId, privateKey })));
  }
  listKeyIds(): Promise<string[]> {
    return Promise.resolve([...this.map.keys()]);
  }
  remove(keyId: string): Promise<void> {
    this.map.delete(keyId);
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.map.clear();
    return Promise.resolve();
  }
}

/** Pick the best available backend for the current environment. */
export function createKeyStore(): KeyStore {
  return hasIndexedDb() ? new IndexedDbKeyStore() : new MemoryKeyStore();
}

/** Process-wide default key store the app + stores share. */
export const keyStore: KeyStore = createKeyStore();
