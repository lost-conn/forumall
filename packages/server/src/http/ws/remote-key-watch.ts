/**
 * §7.1 "Close codes" for a REMOTE actor's direct-WS connection (§8.5): keeping
 * the connection's device key confirmed under the §4.6 cache rules.
 *
 * A remote actor's key is revoked at their home provider, which cannot tell us,
 * so the connection holds the key only as long as the user-keys cache
 * ({@link RemoteUserKeysCache}) vouches for it, and an expired cache entry never
 * keeps the connection open:
 *
 *  - **Re-resolve before expiry (SHOULD).** Within
 *    {@link WsTimings.remoteKeyRefreshLeadMs} of the entry's expiry, every check
 *    forces a re-fetch, so a live connection is not dropped needlessly. Between
 *    those, a check every {@link WsTimings.remoteKeyRevalidateMs} reads the cache
 *    (which fetches only when it holds no unexpired entry with the key), so a
 *    re-fetch made for another reason — a REST verify miss — is seen too.
 *  - **Key gone → `4003`.** Only a completed fetch shows it: a valid keys
 *    response without the key (`no_key`), a `404` (also `no_key`), or a key now
 *    published under the same id with a different public key.
 *  - **Key unconfirmed → `4001`.** A fetch that fails, is rate-limited, or is
 *    refused by the outbound-request rules keeps the connection while the
 *    unexpired entry still holds the key. When the entry reaches its expiry with
 *    no completed fetch having refreshed it — tried or not, and even with a
 *    fetch still in flight — the connection closes with `4001`. A deadline
 *    timer fires exactly then, so the close does not wait for a heartbeat.
 *  - **No cache entry.** A key confirmed by a fetch whose document was not
 *    cached (its `cache_until` already past) has no entry: it stays confirmed
 *    until the next re-fetch, and the first failed, rate-limited or refused one
 *    closes with `4001`.
 *  - **Federation policy → `4001`.** Checked on every tick and after every
 *    lookup, whatever the cache holds (§4.6, §8 Authorization).
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
  /** Cache-clock time the last lookup started. */
  lastCheck: number;
  /** A lookup is in flight (don't start another). */
  inFlight: boolean;
  /** Fires at {@link confirmedUntil} to close a connection left unconfirmed. */
  deadlineTimer?: ReturnType<typeof setTimeout>;
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
  state.remoteKey = {
    domain,
    publicKey: lookup.key.publicKey,
    confirmedUntil: lookup.expiresAt,
    lastCheck: ctx.userKeysCache.now(),
    inFlight: false,
  };
  armDeadline(ctx, ws, state);
}

/**
 * Stop watching: clear the deadline timer and detach the watch, so a lookup
 * still in flight finds it gone and does nothing (teardown / terminate).
 * Idempotent.
 */
export function stopRemoteKeyWatch(state: ConnState): void {
  clearDeadline(state.remoteKey);
  state.remoteKey = undefined;
}

/** Clear a watch's deadline timer, if armed. */
function clearDeadline(watch: RemoteKeyWatch | undefined): void {
  if (watch?.deadlineTimer !== undefined) {
    clearTimeout(watch.deadlineTimer);
    watch.deadlineTimer = undefined;
  }
}

/**
 * One check of a remote connection's key; run on every heartbeat tick and by
 * the deadline timer. Closes on a policy denial or a lapsed confirmation, and
 * otherwise starts a lookup when one is due (see the module docs).
 */
export function checkRemoteKey(ctx: WsCtx, ws: WsContext, state: ConnState): void {
  const watch = state.remoteKey;
  const { actor, keyId } = state;
  if (!watch || !state.authenticated || state.terminated) return;
  if (actor === undefined || keyId === undefined) return;
  if (closeIfDenied(ctx, ws, state, watch) || closeIfLapsed(ctx, ws, state, watch)) return;
  if (watch.inFlight) return;

  const now = ctx.userKeysCache.now();
  const nearExpiry =
    watch.confirmedUntil !== null &&
    now >= watch.confirmedUntil - ctx.timings.remoteKeyRefreshLeadMs;
  if (!nearExpiry && now - watch.lastCheck < ctx.timings.remoteKeyRevalidateMs) return;

  watch.inFlight = true;
  watch.lastCheck = now;
  void ctx.userKeysCache
    .lookupActorKey(actor, keyId, { forceRefresh: nearExpiry })
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
      watch.confirmedUntil = lookup.expiresAt;
      armDeadline(ctx, ws, state);
      return;
    case "no_key":
      terminate(ctx, ws, state, WS_CLOSE_CREDENTIALS_REVOKED, "device key revoked");
      return;
    default:
      // `fetch_failed` / `rate_limited` / `refused`: not evidence of revocation.
      // Without a cache entry the key is unconfirmed now; with one, only once
      // the entry lapses.
      if (watch.confirmedUntil === null) {
        terminate(ctx, ws, state, WS_CLOSE_AUTH_FAILED, unconfirmedReason(lookup.kind));
        return;
      }
      closeIfLapsed(ctx, ws, state, watch);
  }
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

/**
 * (Re)arm the timer that checks the connection the moment its confirmation
 * lapses. The check itself compares on the cache's clock, so a timer that fires
 * early (another clock, or a delay clamped to the timer maximum) only looks.
 */
function armDeadline(ctx: WsCtx, ws: WsContext, state: ConnState): void {
  const watch = state.remoteKey;
  clearDeadline(watch);
  if (!watch || watch.confirmedUntil === null) return;
  const delay = Math.min(
    Math.max(0, watch.confirmedUntil - ctx.userKeysCache.now()),
    MAX_TIMER_DELAY_MS,
  );
  watch.deadlineTimer = setTimeout(() => {
    watch.deadlineTimer = undefined;
    checkRemoteKey(ctx, ws, state);
    // Fired before the lapse (see above) and nothing re-armed it: keep watching.
    if (!state.terminated && state.remoteKey === watch && watch.deadlineTimer === undefined) {
      armDeadline(ctx, ws, state);
    }
  }, delay);
}
