/**
 * A small in-memory rate limiter for the auth endpoints (§4.1.5 SHOULD; see
 * `../../antsome/docs/forumall-spec-reconciliation.md` #26).
 *
 * Forumall runs as one process per deployment (CLAUDE.md "Single-process
 * assumptions" — the nonce store and the WS hub are already in-memory for the
 * same reason), so an in-memory limiter is simpler and cheaper than a
 * database-backed one and needs no extra dependency (CLAUDE.md: pure-JS deps
 * only). Two pieces, both ported from Antsome's reference design
 * (`antsome-server/src/ratelimit.rs`):
 *
 * - {@link WindowLimiter}: a plain fixed-window counter, keyed by an arbitrary
 *   string. `http/auth.ts` checks the SAME limiter instance twice per request
 *   — once keyed `ip:<addr>`, once keyed `handle:<handle>` — so an attacker
 *   can't work around either axis by varying the other.
 * - {@link LoginBackoff}: progressive lockout for repeated failed logins
 *   against one handle, on top of (not instead of) the plain login window
 *   limit. Applies identically to unknown handles (keyed on the submitted
 *   handle text, not on whether an account exists) so it never leaks handle
 *   existence.
 *
 * {@link RateLimits} bundles one `WindowLimiter` per rate-limited endpoint plus
 * the login backoff, and lives on `c.var.rateLimits` (see `app.ts`).
 * {@link createRateLimits} builds it from {@link Config}; {@link disabledRateLimits}
 * gives a bypass for tests/deployments that opt out via `RATE_LIMIT_ENABLED=false`.
 */
import type { Config } from "../config.ts";

/** The outcome of a single {@link WindowLimiter.check} / {@link LoginBackoff.check} call. */
export type RateLimitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSeconds: number };

interface Window {
  count: number;
  startedAt: number;
}

/** Prune the backing map once it grows past this many distinct keys. */
const PRUNE_THRESHOLD = 10_000;

/**
 * A fixed-window request counter, keyed by an arbitrary string (an IP, a
 * handle, or any other caller-chosen key). One instance is checked against
 * MULTIPLE keys per request (see file docs) so it can enforce both an
 * IP-based and a handle-based limit without two separate maps to keep in
 * sync.
 */
export class WindowLimiter {
  private readonly windows = new Map<string, Window>();

  /** At most `limit` hits per `windowMs`, per key. */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** A limiter that never limits anything. */
  static unlimited(): WindowLimiter {
    return new WindowLimiter(Number.POSITIVE_INFINITY, 1000);
  }

  /**
   * Record one hit for `key`. The hit is counted even when it pushes the
   * caller over the limit, so hammering the endpoint doesn't reset the
   * window early. `now` is injectable for tests.
   */
  check(key: string, now = Date.now()): RateLimitResult {
    let w = this.windows.get(key);
    if (!w || now - w.startedAt >= this.windowMs) {
      w = { count: 0, startedAt: now };
      this.windows.set(key, w);
    }
    w.count += 1;

    this.prune(now);

    if (w.count > this.limit) {
      const elapsedMs = now - w.startedAt;
      const retryMs = Math.max(this.windowMs - elapsedMs, 1000);
      return { ok: false, retryAfterSeconds: Math.ceil(retryMs / 1000) };
    }
    return { ok: true };
  }

  /**
   * Opportunistic cleanup so a long-running process doesn't grow this map
   * without bound. Never touches the correctness of {@link check} — it only
   * drops windows that are already long expired.
   */
  private prune(now: number): void {
    if (this.windows.size <= PRUNE_THRESHOLD) return;
    for (const [key, w] of this.windows) {
      if (now - w.startedAt >= this.windowMs * 2) this.windows.delete(key);
    }
  }
}

/** Consecutive failures before a lockout starts. A couple of typos shouldn't lock anyone out. */
const LOCKOUT_STARTS_AFTER = 3;
/** Longest a lockout ever runs. */
const MAX_LOCKOUT_SECONDS = 300;

interface Lock {
  consecutiveFailures: number;
  lockedUntil: number | null;
}

/**
 * Progressive backoff after repeated failed logins for one handle (§4.1.5
 * "SHOULD apply progressive backoff or temporary lockout"). Independent of
 * {@link WindowLimiter}: this locks out a specific handle for longer and
 * longer after consecutive failures, regardless of how many distinct IPs are
 * trying it, and resets on a successful login. Applies to unknown handles
 * exactly like known ones (keyed on the submitted text) so it can never be
 * used to tell the two apart.
 */
export class LoginBackoff {
  private readonly locks = new Map<string, Lock>();

  private constructor(private readonly enabled: boolean) {}

  static create(): LoginBackoff {
    return new LoginBackoff(true);
  }

  /** Never locks anyone out — for `RATE_LIMIT_ENABLED=false` / tests that don't care about backoff. */
  static disabled(): LoginBackoff {
    return new LoginBackoff(false);
  }

  /** Whether `handleKey` is currently locked out. */
  check(handleKey: string, now = Date.now()): RateLimitResult {
    if (!this.enabled) return { ok: true };
    const lock = this.locks.get(handleKey);
    if (lock?.lockedUntil != null && now < lock.lockedUntil) {
      return { ok: false, retryAfterSeconds: Math.ceil((lock.lockedUntil - now) / 1000) };
    }
    return { ok: true };
  }

  /** Record a failed login attempt, extending the lockout once {@link LOCKOUT_STARTS_AFTER} piles up. */
  recordFailure(handleKey: string, now = Date.now()): void {
    if (!this.enabled) return;
    const lock = this.locks.get(handleKey) ?? { consecutiveFailures: 0, lockedUntil: null };
    lock.consecutiveFailures += 1;
    if (lock.consecutiveFailures >= LOCKOUT_STARTS_AFTER) {
      const over = lock.consecutiveFailures - LOCKOUT_STARTS_AFTER;
      const seconds = Math.min(2 ** Math.min(over, 20), MAX_LOCKOUT_SECONDS);
      lock.lockedUntil = now + seconds * 1000;
    }
    this.locks.set(handleKey, lock);
    if (this.locks.size > PRUNE_THRESHOLD) this.prune(now);
  }

  /** A successful login clears any accumulated failures for the handle. */
  recordSuccess(handleKey: string): void {
    if (!this.enabled) return;
    this.locks.delete(handleKey);
  }

  private prune(now: number): void {
    for (const [key, lock] of this.locks) {
      const stale = lock.lockedUntil == null || now >= lock.lockedUntil;
      if (stale) this.locks.delete(key);
    }
  }
}

/**
 * Every rate limiter the auth endpoints use (§4.1.5: `/api/auth/login`,
 * `/api/auth/register`, `/api/auth/recover` — not yet implemented, see
 * reconciliation #27, but wired up ready for it — and `/api/auth/device-keys`),
 * plus the login backoff. Lives on `c.var.rateLimits` (`http/types.ts`); one
 * instance is shared across the whole app (created in `app.ts`).
 */
export interface RateLimits {
  readonly register: WindowLimiter;
  readonly login: WindowLimiter;
  readonly recover: WindowLimiter;
  readonly deviceKeys: WindowLimiter;
  readonly loginBackoff: LoginBackoff;
}

/** Build the production limiter set from validated config (`RATE_LIMIT_*` env, `config.ts`). */
export function createRateLimits(config: Config): RateLimits {
  if (!config.rateLimit.enabled) return disabledRateLimits();
  return {
    register: new WindowLimiter(
      config.rateLimit.register.max,
      config.rateLimit.register.windowSeconds * 1000,
    ),
    login: new WindowLimiter(
      config.rateLimit.login.max,
      config.rateLimit.login.windowSeconds * 1000,
    ),
    recover: new WindowLimiter(
      config.rateLimit.recover.max,
      config.rateLimit.recover.windowSeconds * 1000,
    ),
    deviceKeys: new WindowLimiter(
      config.rateLimit.deviceKeys.max,
      config.rateLimit.deviceKeys.windowSeconds * 1000,
    ),
    loginBackoff: LoginBackoff.create(),
  };
}

/** Never limits anything — `RATE_LIMIT_ENABLED=false` (self-host operators who don't want it) and tests. */
export function disabledRateLimits(): RateLimits {
  return {
    register: WindowLimiter.unlimited(),
    login: WindowLimiter.unlimited(),
    recover: WindowLimiter.unlimited(),
    deviceKeys: WindowLimiter.unlimited(),
    loginBackoff: LoginBackoff.disabled(),
  };
}
