/**
 * Bounds the key fetches that inbound requests can make to ONE HOST (spec §8
 * Outbound requests: lookups triggered by inbound requests SHOULD be
 * rate-limited "so that a stream of requests naming random key ids cannot be
 * used to make it hammer a third-party provider").
 *
 * The per-identity {@link RefetchLimiter} alone cannot do this for user keys:
 * a requester picks the actor, so `r1@victim.example`, `r2@victim.example`, …
 * (a fresh handle per request) are all "new" identities and each would start
 * its own GET to `victim.example`. This limiter is keyed by the canonical
 * authority (§2.2, host[:port]) actually contacted, and is consulted only when
 * a NEW fetch would start (see {@link RefetchLimiter.run}'s `admit`).
 *
 * ## Per host
 *  - **Token bucket.** Up to `burst` fetches may start back to back; tokens then
 *    refill continuously at `refillPerSecond`. Starting a fetch takes one token.
 *  - **In-flight cap.** At most `maxInFlight` fetches to the host run at once;
 *    a slot is freed when the fetch settles — success, failure or throw.
 *
 * A fetch that either rule blocks is {@link RateLimited} (→ `503` +
 * `Retry-After`, §4.6) with `retryAfterMs` = the time until BOTH allow a start:
 *  - tokens: the exact time until the bucket holds one whole token;
 *  - in flight: the time until the OLDEST in-flight fetch must have settled,
 *    i.e. its start + `fetchDeadlineMs` (default {@link DEFAULT_EGRESS_TIMEOUT_MS},
 *    the egress deadline that covers DNS + request + body). This is an upper
 *    bound — a slot usually frees sooner — and never less than 1 ms.
 * A refused fetch consumes nothing.
 *
 * ## Memory (bounded)
 * One small record per host, kept in least-recently-used order. Each call
 * first sweeps hosts that have been idle for at least the full-refill time
 * (`burst / refillPerSecond`) with nothing in flight: such a host's bucket is
 * full again, so forgetting it is lossless. A sweep stops at the first host
 * touched more recently than that (skipping, not stopping at, hosts untouched
 * that long that still have a fetch in flight). On top of that, at most `maxHosts` hosts are
 * tracked; a NEW host beyond the cap evicts the least recently used host that
 * has nothing in flight. A busy host is never evicted (that would reset its
 * in-flight count and let its cap be exceeded); if every tracked host is busy,
 * the new host is refused (`rate_limited`) until a fetch settles. Evicting an
 * idle host is lossy only for its bucket (it next starts full), so it can only
 * be forced by naming more than `maxHosts` distinct hosts — each costing the
 * requester a fetch of its own — within one full-refill window.
 *
 * Trade-off: a requester who can keep `maxHosts` fetches in flight at once (e.g.
 * many hosts under a wildcard DNS name that answer slowly) makes every NEW host
 * wait — `rate_limited` — for up to one fetch deadline while that lasts. This is
 * chosen over the alternative, evicting a busy host, which would let a named
 * victim's cap be exceeded; hosts already tracked are unaffected.
 *
 * Scope: this bounds load per host, not total egress. Requests naming many
 * DIFFERENT hosts cost each of them at most `burst` fetches; distinct ports
 * of one hostname are distinct authorities (§2.2) and are limited separately.
 */
import { DEFAULT_EGRESS_TIMEOUT_MS } from "./egress-guard.ts";
import type { FetchAdmission } from "./refetch-limiter.ts";

/** Tunables for {@link HostFetchLimiter}. */
export interface HostFetchLimits {
  /** Fetches that may start back to back once a host's bucket is full (integer ≥ 1). */
  readonly burst: number;
  /** Steady refill rate, in fetches per second (> 0). */
  readonly refillPerSecond: number;
  /** Fetches to one host allowed in flight at once (integer ≥ 1). */
  readonly maxInFlight: number;
  /** Hosts tracked at most; beyond it the least recently used idle host is evicted (integer ≥ 1). */
  readonly maxHosts: number;
  /** Longest a fetch can run (ms, > 0): bounds the wait reported for a full in-flight cap. */
  readonly fetchDeadlineMs: number;
}

/**
 * Defaults: 20 back to back, then 5 per second, 4 at a time, per host. A cold
 * start against a busy peer (many of its users seen at once) is served at that
 * rate, and each actor's keys are then cached (`cache_until`, ≤ 1 h).
 */
export const DEFAULT_HOST_FETCH_LIMITS: HostFetchLimits = Object.freeze({
  burst: 20,
  refillPerSecond: 5,
  maxInFlight: 4,
  maxHosts: 10_000,
  fetchDeadlineMs: DEFAULT_EGRESS_TIMEOUT_MS,
});

interface HostState {
  /** Tokens in the bucket as of `touchedAt` (fractional; ≤ burst). */
  tokens: number;
  /** When the host was last consulted (and the bucket last refilled). */
  touchedAt: number;
  /** Start times of the fetches in flight (≤ maxInFlight entries). */
  readonly inFlight: number[];
}

export class HostFetchLimiter {
  readonly #limits: HostFetchLimits;
  readonly #now: () => number;
  /** Full-refill time (ms): an untouched host is back to a full bucket after it. */
  readonly #idleMs: number;
  /** Per-host state, least recently touched first (delete + set on each touch). */
  readonly #hosts = new Map<string, HostState>();

  constructor(opts: { readonly limits?: Partial<HostFetchLimits>; readonly now: () => number }) {
    const limits = { ...DEFAULT_HOST_FETCH_LIMITS, ...opts.limits };
    requireInteger("burst", limits.burst);
    requireInteger("maxInFlight", limits.maxInFlight);
    requireInteger("maxHosts", limits.maxHosts);
    requirePositive("refillPerSecond", limits.refillPerSecond);
    requirePositive("fetchDeadlineMs", limits.fetchDeadlineMs);
    this.#limits = limits;
    this.#now = opts.now;
    this.#idleMs = (limits.burst * 1000) / limits.refillPerSecond;
  }

  /** Hosts currently tracked (for tests and diagnostics). */
  get trackedHosts(): number {
    return this.#hosts.size;
  }

  /**
   * Ask to start one fetch to `host`. It is refused (`rate_limited`) when the
   * host's bucket is empty, its in-flight cap is reached, or it is a new host and
   * the table is full of busy hosts (wait: one fetch deadline, an upper bound —
   * a slot may free sooner). When admitted, a token and an in-flight slot are
   * taken; the caller MUST call `release` once when the fetch settles
   * (later calls are ignored).
   */
  tryStart(host: string): FetchAdmission {
    const now = this.#now();
    this.#sweep(now);
    const { maxInFlight, refillPerSecond, fetchDeadlineMs } = this.#limits;
    const state = this.#touch(host, now);
    // Every tracked host has a fetch in flight and the table is full: admitting a
    // new host would mean forgetting a busy one (resetting its cap), so refuse
    // until one settles — at the latest, one fetch deadline from now.
    if (state === null) return { kind: "rate_limited", retryAfterMs: fetchDeadlineMs };

    let wait = 0;
    if (state.tokens < 1) {
      wait = Math.ceil(((1 - state.tokens) * 1000) / refillPerSecond);
    }
    if (state.inFlight.length >= maxInFlight) {
      const oldest = Math.min(...state.inFlight);
      // Clamp: a clock that stepped backwards must not stretch it past one deadline.
      wait = Math.max(wait, Math.min(oldest + fetchDeadlineMs - now, fetchDeadlineMs), 1);
    }
    if (wait > 0) return { kind: "rate_limited", retryAfterMs: wait };

    state.tokens -= 1;
    state.inFlight.push(now);
    let released = false;
    return {
      kind: "admitted",
      release: () => {
        if (released) return;
        released = true;
        // A host with a fetch in flight is never evicted or swept, so `state` is live.
        state.inFlight.splice(state.inFlight.indexOf(now), 1);
      },
    };
  }

  /**
   * The host's state, refilled to `now` and moved to the most-recent end; `null`
   * when the host is new, the table is full, and every tracked host is busy.
   */
  #touch(host: string, now: number): HostState | null {
    let state = this.#hosts.get(host);
    if (state) {
      this.#hosts.delete(host);
      // A clock that stepped backwards refills nothing (and never drains).
      const elapsed = Math.max(0, now - state.touchedAt);
      const refill = (elapsed * this.#limits.refillPerSecond) / 1000;
      state.tokens = Math.min(this.#limits.burst, state.tokens + refill);
      state.touchedAt = now;
    } else {
      if (this.#hosts.size >= this.#limits.maxHosts && !this.#evictIdle()) return null;
      state = { tokens: this.#limits.burst, touchedAt: now, inFlight: [] };
    }
    this.#hosts.set(host, state);
    return state;
  }

  /**
   * Evict the least recently touched host with nothing in flight. Never evicts a
   * busy host: that would reset its in-flight count and let its cap be exceeded.
   * Returns false when every tracked host is busy.
   */
  #evictIdle(): boolean {
    for (const [host, state] of this.#hosts) {
      if (state.inFlight.length === 0) {
        this.#hosts.delete(host);
        return true;
      }
    }
    return false;
  }

  /** Forget hosts idle for a full refill with nothing in flight (lossless). */
  #sweep(now: number): void {
    for (const [host, state] of this.#hosts) {
      if (now - state.touchedAt < this.#idleMs) return;
      if (state.inFlight.length === 0) this.#hosts.delete(host);
    }
  }
}

function requireInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`host fetch limit ${name} must be an integer ≥ 1, got ${value}`);
  }
}

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`host fetch limit ${name} must be a finite number > 0, got ${value}`);
  }
}
