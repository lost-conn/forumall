/**
 * The bounded store behind both remote-key caches ({@link RemoteUserKeysCache}
 * per actor, {@link RemoteDiscoveryCache} per provider authority).
 *
 * Both are keyed by identities a requester chooses (`r1@evil.example`,
 * `r2@evil.example`, … or `a.evil.example`, `b.evil.example`, …), so an
 * unbounded map would let anyone grow this provider's memory without limit.
 * This store bounds it two ways:
 *
 *  - **Expired entries are removed.** `get` deletes the expired entry it finds,
 *    and `set` sweeps every expired entry at most once per
 *    {@link EXPIRED_SWEEP_INTERVAL_MS} (expiries do not follow insertion order,
 *    so a sweep scans the whole map; the interval keeps that amortized).
 *  - **At most `maxEntries` are kept.** Past the cap the least recently used
 *    entry (stored or read) is evicted. Evicting an unexpired entry only costs
 *    a re-fetch later: an evicted entry vouches for nothing, which is always
 *    the safe direction (§4.6 — only an unexpired entry counts, and a missing
 *    one means "fetch").
 */
import type { CachedDocument } from "./key-lookup.ts";

/** Default cap on cached documents per cache. */
export const DEFAULT_MAX_CACHED_DOCUMENTS = 10_000;

/** Minimum time between two full sweeps for expired entries. */
export const EXPIRED_SWEEP_INTERVAL_MS = 60_000;

export class ExpiringEntries<D> {
  /** Map order is recency order: every store or read re-inserts its key. */
  readonly #entries = new Map<string, CachedDocument<D>>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  #lastSweep: number;

  constructor(opts: { readonly maxEntries: number; readonly now: () => number }) {
    requireCountAtLeastOne("maxEntries", opts.maxEntries);
    this.#maxEntries = opts.maxEntries;
    this.#now = opts.now;
    this.#lastSweep = opts.now();
  }

  /** Number of entries held, expired ones not yet removed included. */
  get size(): number {
    return this.#entries.size;
  }

  /** The unexpired entry for `key` (marking it recently used), else `null`. */
  get(key: string): CachedDocument<D> | null {
    const hit = this.#entries.get(key);
    if (!hit) return null;
    this.#entries.delete(key);
    if (hit.expiresAt <= this.#now()) return null;
    this.#entries.set(key, hit);
    return hit;
  }

  /** Store `doc` for `key` until `expiresAt` (cache clock, epoch ms). */
  set(key: string, doc: D, expiresAt: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { doc, expiresAt });
    const now = this.#now();
    // `now < #lastSweep`: the clock stepped back; sweep rather than wait it out.
    if (now - this.#lastSweep >= EXPIRED_SWEEP_INTERVAL_MS || now < this.#lastSweep) {
      this.#sweepExpired(now);
    }
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  #sweepExpired(now: number): void {
    this.#lastSweep = now;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}

/** Throw a `RangeError` unless `value` is an integer ≥ 1 (a count option). */
export function requireCountAtLeastOne(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer ≥ 1, got ${value}`);
  }
}
