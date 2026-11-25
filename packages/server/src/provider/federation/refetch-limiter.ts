/**
 * Bounds the key fetches that inbound requests can trigger (spec §4.6 "MAY
 * limit these re-fetches per actor", §8.1 "per provider", §8 Outbound
 * requests "SHOULD rate-limit lookups triggered by inbound requests").
 *
 * Without a bound, any request can make this provider fetch from the domain it
 * names: an unknown `key_id`, a garbage signature over a real `key_id` (which
 * forces a re-fetch of a cached key), or a peer whose `cache_until` is already
 * past (nothing is cached, so every request fetches). A stream of such
 * requests would turn this provider into a tool for hammering a third party.
 *
 * Per identity (an actor for user keys, a provider authority for discovery):
 *  - **Single flight.** While a fetch is in progress, every other lookup for the
 *    same identity waits for it and shares its result instead of starting a
 *    second one.
 *  - **One fetch per interval.** A new fetch starts only when `intervalMs` has
 *    passed since the previous one STARTED. Inside the interval the lookup is
 *    {@link RateLimited}, carrying the time until a fetch is allowed again, so
 *    the verifier can answer `503` + `Retry-After` (§4.6) rather than `401`.
 *
 * The limiter never serves data itself: the caches consult their UNEXPIRED
 * entries before asking it for a fetch, so a suppressed fetch never means an
 * expired entry gets used (§4.6).
 *
 * Memory: an identity is remembered only while its interval runs (plus until
 * the next sweep), so requests naming random identities cannot grow it beyond
 * what one interval's worth of traffic produces.
 */

/** Default minimum time (ms) between two network fetches for one identity. */
export const DEFAULT_REFETCH_INTERVAL_MS = 1_000;

/** A fetch suppressed by the per-identity limit. */
export interface RateLimited {
  readonly kind: "rate_limited";
  /** Milliseconds until a fetch for this identity is allowed again (> 0). */
  readonly retryAfterMs: number;
}

export class RefetchLimiter<R> {
  readonly #intervalMs: number;
  readonly #now: () => number;
  /** The fetch in progress per identity (single flight). */
  readonly #inFlight = new Map<string, Promise<R>>();
  /**
   * Start time of each identity's latest fetch. Kept in start order (an entry
   * is deleted before it is re-set), so expired entries are always a prefix.
   */
  readonly #lastStart = new Map<string, number>();

  constructor(opts: { readonly intervalMs: number; readonly now: () => number }) {
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs < 0) {
      throw new RangeError(`refetch interval must be a finite number ≥ 0, got ${opts.intervalMs}`);
    }
    this.#intervalMs = opts.intervalMs;
    this.#now = opts.now;
  }

  /**
   * Run `fetch` for `id` unless one is already in flight (join it) or the
   * previous one started less than the interval ago ({@link RateLimited}).
   */
  run(id: string, fetch: () => Promise<R>): Promise<R | RateLimited> {
    const pending = this.#inFlight.get(id);
    if (pending) return pending;

    const now = this.#now();
    this.#sweep(now);
    const last = this.#lastStart.get(id);
    if (last !== undefined) {
      const wait = last + this.#intervalMs - now;
      if (wait > 0) {
        // Clamp: a clock that stepped backwards must not stretch the wait.
        const retryAfterMs = Math.min(wait, this.#intervalMs);
        return Promise.resolve({ kind: "rate_limited", retryAfterMs });
      }
    }

    this.#lastStart.delete(id);
    this.#lastStart.set(id, now);
    const started = fetch().finally(() => {
      this.#inFlight.delete(id);
    });
    this.#inFlight.set(id, started);
    return started;
  }

  /** Forget identities whose interval has passed (they are a prefix of the map). */
  #sweep(now: number): void {
    for (const [id, start] of this.#lastStart) {
      if (now - start < this.#intervalMs) return;
      this.#lastStart.delete(id);
    }
  }
}
