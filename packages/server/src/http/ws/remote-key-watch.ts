/**
 * §7.1 "Close codes" for a REMOTE actor's direct-WS connection (§8.5): keeping
 * the connection's device key confirmed under the §4.6 cache rules.
 *
 * A remote actor's key is revoked at their home provider, which cannot tell us,
 * so the connection holds the key only as long as the user-keys cache
 * ({@link RemoteUserKeysCache}) vouches for it, and an expired cache entry never
 * keeps the connection open:
 *
 *  - **Re-resolve before expiry (SHOULD).** Each confirmation sets a refresh
 *    point: {@link WsTimings.remoteKeyRefreshLeadMs} before the entry's expiry,
 *    or halfway through the entry's remaining life when that is shorter. From
 *    then on every check forces a re-fetch. A timer wakes at the refresh point
 *    and then halfway through what remains, so retries do not wait for a
 *    heartbeat. Between refreshes, a check every
 *    {@link WsTimings.remoteKeyRevalidateMs} reads the cache, which fetches only
 *    when it holds no unexpired entry with the key.
 *  - **A fetch made for another reason counts.** Every check first consults the
 *    cache's last completed fetch of the actor's keys
 *    ({@link RemoteUserKeysCache.lastCompletedFetch}), whoever made it (a REST
 *    verify, another connection). If it no longer publishes the key, that is a
 *    completed fetch showing the key gone. If its cached entry outlives the
 *    connection's, the connection is confirmed until then.
 *  - **Key gone → `4003`.** Only a completed fetch shows it: a valid keys
 *    response without the key, a `404`, or a different public key under the
 *    same id.
 *  - **Key unconfirmed → `4001`.** A fetch that fails, is rate-limited, or is
 *    refused by the outbound-request rules keeps the connection while the
 *    unexpired entry still holds the key. When the entry reaches its expiry with
 *    no completed fetch having refreshed it — tried or not, and even with a
 *    fetch still in flight — the connection closes with `4001`. The timer's last
 *    wake is that expiry, so the close does not wait for a heartbeat.
 *  - **No cache entry.** A key confirmed by a fetch whose document was not
 *    cached (its `cache_until` already past) has no entry: it stays confirmed
 *    until the next re-fetch, and the first failed, rate-limited or refused one
 *    closes with `4001`.
 *  - **Federation policy → `4001`.** Checked on every heartbeat tick, every
 *    timer wake and after every lookup, whatever the cache holds (§4.6, §8
 *    Authorization). The policy (`FEDERATION_ALLOW`/`DENY`) is fixed for the
 *    life of the process today, so in practice it changes only across a
 *    restart, which drops every connection anyway. A runtime policy change
 *    would need to call {@link checkRemoteKey} on the affected connections to
 *    close them at once.
 *
 * All expiry arithmetic is on the CACHE's clock ({@link RemoteUserKeysCache.now}),
 * the clock its entries' `expiresAt` are on; timers only decide when to look.
 */
import { WS_CLOSE_CREDENTIALS_REVOKED } from "../../provider/access-revocation.ts";
import type { KeyLookup } from "../../provider/federation/key-lookup.ts";
import { isProviderAllowed } from "../../provider/federation/policy.ts";
import type { RemoteActorKey } from "../../provider/federation/user-keys-cache.ts";
import {
  type ConnState,
  WS_CLOSE_AUTH_FAILED,
  type WsContext,
  type WsCtx,
  terminate,
} from "./connection.ts";

/** The largest delay `setTimeout` honours (2³¹−1 ms); longer ones fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Below this much remaining life, the timer stops halving and waits for expiry. ms. */
const MIN_RETRY_SPACING_MS = 1_000;

/**
 * What a remote connection knows about its key. Created by the handshake
 * ({@link startRemoteKeyWatch}) and kept on {@link ConnState.remoteKey}.
 */
export interface RemoteKeyWatch {
  /** The actor's canonical home domain (for the federation-policy check). */
  readonly domain: string;
  /** The public key that verified the handshake. */
  readonly publicKey: string;
  /**
   * When the cache entry vouching for the key lapses (cache clock, epoch ms), or
   * `null` when no entry holds it (confirmed by an uncached fetch only).
   */
  confirmedUntil: number | null;
  /** From this time (cache clock) every check forces a re-fetch; see the module docs. */
  refreshAt: number | null;
  /** Cache-clock time the last lookup started. */
  lastCheck: number;
  /** A lookup is in flight (don't start another). */
  inFlight: boolean;
  /** Wakes the watch at its refresh point, retry points and expiry. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Begin watching a remote connection's key after a successful handshake.
 * `lookup` is the `found` outcome that verified it.
 */
export function startRemoteKeyWatch(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  domain: string,
  lookup: Extract<KeyLookup<RemoteActorKey>, { kind: "found" }>,
): void {
  const now = ctx.userKeysCache.now();
  const watch: RemoteKeyWatch = {
    domain,
    publicKey: lookup.key.publicKey,
    confirmedUntil: null,
    refreshAt: null,
    lastCheck: now,
    inFlight: false,
  };
  state.remoteKey = watch;
  confirm(ctx, ws, state, watch, lookup.expiresAt);
}

/**
 * Stop watching: clear the timer and detach the watch, so a lookup still in
 * flight finds it gone and does nothing (teardown). Idempotent.
 */
export function stopRemoteKeyWatch(state: ConnState): void {
  clearTimer(state.remoteKey);
  state.remoteKey = undefined;
}

/**
 * One check of a remote connection's key; run on every heartbeat tick and by
 * the watch's timer. Closes on a policy denial, on a completed fetch that shows
 * the key gone, or on a lapsed confirmation; otherwise starts a lookup when one
 * is due (see the module docs).
 */
export function checkRemoteKey(ctx: WsCtx, ws: WsContext, state: ConnState): void {
  const watch = state.remoteKey;
  if (!watch || !state.authenticated || state.terminated) return;
  if (closeIfDenied(ctx, ws, state, watch)) return;
  if (adoptLastFetch(ctx, ws, state, watch) || closeIfLapsed(ctx, ws, state, watch)) return;
  if (watch.inFlight) return;

  const { actor, keyId } = state;
  if (actor === undefined || keyId === undefined) return;
  const now = ctx.userKeysCache.now();
  const refreshDue = watch.refreshAt !== null && now >= watch.refreshAt;
  if (!refreshDue && now - watch.lastCheck < ctx.timings.remoteKeyRevalidateMs) return;

  watch.inFlight = true;
  watch.lastCheck = now;
  void ctx.userKeysCache
    .lookupActorKey(actor, keyId, { forceRefresh: refreshDue })
    .catch(
      (err): KeyLookup<RemoteActorKey> => ({
        kind: "fetch_failed",
        reason: err instanceof Error ? err.message : String(err),
      }),
    )
    .then((lookup) => {
      watch.inFlight = false;
      applyLookup(ctx, ws, state, watch, lookup);
    });
}

/** Act on a re-resolution's outcome (see the module docs). */
function applyLookup(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  watch: RemoteKeyWatch,
  lookup: KeyLookup<RemoteActorKey>,
): void {
  // The connection closed (or was terminated) while the lookup was in flight.
  if (state.terminated || state.remoteKey !== watch) return;
  if (closeIfDenied(ctx, ws, state, watch)) return;
  switch (lookup.kind) {
    case "found":
      if (lookup.key.publicKey !== watch.publicKey) {
        // A completed fetch published a different key under this id: ours is gone.
        terminate(ctx, ws, state, WS_CLOSE_CREDENTIALS_REVOKED, "device key revoked");
        return;
      }
      confirm(ctx, ws, state, watch, lookup.expiresAt);
      return;
    case "no_key":
      terminate(ctx, ws, state, WS_CLOSE_CREDENTIALS_REVOKED, "device key revoked");
      return;
    default: {
      // `fetch_failed` / `rate_limited` / `refused`: not evidence of revocation.
      // A fetch someone else completed may still settle it either way.
      const before = watch.confirmedUntil;
      if (adoptLastFetch(ctx, ws, state, watch)) return;
      // Without a cache entry the key is unconfirmed now — unless that other
      // fetch just gave it one; with an entry, only once the entry lapses.
      if (before === null && watch.confirmedUntil === null) {
        terminate(ctx, ws, state, WS_CLOSE_AUTH_FAILED, unconfirmedReason(lookup.kind));
        return;
      }
      closeIfLapsed(ctx, ws, state, watch);
    }
  }
}

/**
 * Apply what the cache's last completed fetch of the actor's keys shows (see
 * the module docs): `4003` when it no longer publishes the key, or a longer
 * confirmation when its unexpired entry outlives the connection's. Returns
 * whether the connection was closed.
 */
function adoptLastFetch(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  watch: RemoteKeyWatch,
): boolean {
  const { actor, keyId } = state;
  if (actor === undefined || keyId === undefined) return false;
  const last = ctx.userKeysCache.lastCompletedFetch(actor, keyId);
  if (!last) return false;
  if (last.key === null || last.key.publicKey !== watch.publicKey) {
    terminate(ctx, ws, state, WS_CLOSE_CREDENTIALS_REVOKED, "device key revoked");
    return true;
  }
  if (
    last.expiresAt !== null &&
    (watch.confirmedUntil === null || last.expiresAt > watch.confirmedUntil)
  ) {
    confirm(ctx, ws, state, watch, last.expiresAt);
  }
  return false;
}

/**
 * Record a confirmation lasting until `until` (cache clock; `null` = no cache
 * entry), set the next refresh point and re-arm the timer.
 */
function confirm(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  watch: RemoteKeyWatch,
  until: number | null,
): void {
  watch.confirmedUntil = until;
  if (until === null) {
    watch.refreshAt = null;
  } else {
    const remaining = Math.max(0, until - ctx.userKeysCache.now());
    watch.refreshAt = until - Math.min(ctx.timings.remoteKeyRefreshLeadMs, remaining / 2);
  }
  armTimer(ctx, ws, state, watch);
}

/** Close with `4001` if the actor's provider is now denied by federation policy. */
function closeIfDenied(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  watch: RemoteKeyWatch,
): boolean {
  if (isProviderAllowed(ctx.config, watch.domain)) return false;
  terminate(
    ctx,
    ws,
    state,
    WS_CLOSE_AUTH_FAILED,
    `federation with ${watch.domain} is not permitted by this provider's policy`,
  );
  return true;
}

/** Close with `4001` if the cache entry vouching for the key has lapsed. */
function closeIfLapsed(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  watch: RemoteKeyWatch,
): boolean {
  if (watch.confirmedUntil === null || ctx.userKeysCache.now() < watch.confirmedUntil) {
    return false;
  }
  terminate(
    ctx,
    ws,
    state,
    WS_CLOSE_AUTH_FAILED,
    "device key could not be re-confirmed before its cached keys expired",
  );
  return true;
}

/** The close reason for a key left unconfirmed by a lookup of `kind`. */
function unconfirmedReason(kind: "fetch_failed" | "rate_limited" | "refused"): string {
  return `device key could not be re-confirmed (${kind.replace("_", " ")})`;
}

/** Clear a watch's timer, if armed. */
function clearTimer(watch: RemoteKeyWatch | undefined): void {
  if (watch?.timer !== undefined) {
    clearTimeout(watch.timer);
    watch.timer = undefined;
  }
}

/**
 * (Re)arm the watch's timer for its next wake: the refresh point while it is
 * ahead, then halfway through the remaining life (a retry), then the expiry
 * itself. Each wake runs {@link checkRemoteKey}, which compares on the cache's
 * clock, so a wake that comes early (another clock, or a delay clamped to the
 * timer maximum) only looks; the timer is re-armed after every wake.
 */
function armTimer(ctx: WsCtx, ws: WsContext, state: ConnState, watch: RemoteKeyWatch): void {
  clearTimer(watch);
  const until = watch.confirmedUntil;
  if (until === null || watch.refreshAt === null) return;
  const now = ctx.userKeysCache.now();
  let wakeAt: number;
  if (now < watch.refreshAt) {
    wakeAt = watch.refreshAt;
  } else {
    const remaining = until - now;
    wakeAt = remaining > 2 * MIN_RETRY_SPACING_MS ? now + remaining / 2 : until;
  }
  const delay = Math.min(Math.max(0, wakeAt - now), MAX_TIMER_DELAY_MS);
  watch.timer = setTimeout(() => {
    watch.timer = undefined;
    checkRemoteKey(ctx, ws, state);
    // A lookup that completes re-arms through `confirm`; otherwise wake again.
    if (!state.terminated && state.remoteKey === watch && watch.timer === undefined) {
      armTimer(ctx, ws, state, watch);
    }
  }, delay);
}
