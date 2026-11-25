/**
 * Per-connection building blocks of the WebSocket transport (§7.1), shared by
 * every command module under `http/ws/`: the close codes and timings, the
 * per-connection {@link ConnState}, the {@link WsCtx} the handlers run against,
 * the §7.3 `error` event builder, and {@link terminate}.
 */
import type { Config } from "../../config.ts";
import type { Db } from "../../db/index.ts";
import type { FederationFetch } from "../../provider/federation/http.ts";
import type { RemoteUserKeysCache } from "../../provider/federation/user-keys-cache.ts";
import type { NonceStore } from "../../provider/nonce-store.ts";
import type { PresenceRegistry } from "../../provider/presence.ts";
import type { Hub, HubConnection, HubSocket, OutboundEvent } from "../../provider/ws-hub.ts";
import { type RegistryErrorCode, errorCodeStatus } from "../errors.ts";
import type { RemoteKeyWatch } from "./remote-key-watch.ts";

/**
 * Application close code (§7.1 "Close codes"): authentication failed, the
 * actor's provider is refused by federation policy, or a remote connection's
 * key can no longer be confirmed (its cache entry expired without a completed
 * re-fetch). Never used for revocation — that is `4003`
 * (`WS_CLOSE_CREDENTIALS_REVOKED`).
 */
export const WS_CLOSE_AUTH_FAILED = 4001;

/** Allowed ±skew for the `authenticate` timestamp, seconds (§4.5 step 3). */
export const TIMESTAMP_SKEW_SECONDS = 300;

/**
 * Tunable heartbeat / handshake timings. Defaults follow §7.1 RECOMMENDED
 * values; tests inject short values to exercise timeout/close paths quickly.
 */
export interface WsTimings {
  /** Window to send a valid `authenticate` after connect, ms (§7.1: ~10s). */
  authTimeoutMs: number;
  /** Lifetime of the issued challenge nonce, ms (§7.1: ~30s). */
  challengeTtlMs: number;
  /** Period of server-initiated `ping`, ms (§7.1: ~30s). */
  pingIntervalMs: number;
  /** Idle window with no inbound traffic before close, ms (§7.1: ~60s). */
  idleTimeoutMs: number;
  /**
   * How often a REMOTE actor's authenticating device key is re-resolved through
   * the user-keys cache (§4.6), which fetches from the actor's home provider
   * only when it holds no unexpired entry with the key. Checked on the heartbeat
   * tick. See `remote-key-watch.ts` for the §7.1 close rules. ms.
   */
  remoteKeyRevalidateMs: number;
  /**
   * How long before a remote connection's cache entry expires to start forcing
   * re-fetches of the actor's keys (§7.1 "Re-resolve before expiry"), one per
   * heartbeat tick until one completes. Longer than `pingIntervalMs`, so a
   * failed attempt is retried before the entry lapses. ms.
   */
  remoteKeyRefreshLeadMs: number;
}

/** §7.1 RECOMMENDED defaults. */
export const DEFAULT_WS_TIMINGS: WsTimings = {
  authTimeoutMs: 10_000,
  challengeTtlMs: 30_000,
  pingIntervalMs: 30_000,
  idleTimeoutMs: 60_000,
  remoteKeyRevalidateMs: 300_000,
  remoteKeyRefreshLeadMs: 120_000,
};

/** Random bytes for a challenge nonce (16 = 128 bits, §7.1 "≥128-bit"). */
const CHALLENGE_NONCE_BYTES: number = 16;

/** Mint a ≥128-bit base64url challenge nonce. */
export function mintChallengeNonce(): string {
  const raw = new Uint8Array(CHALLENGE_NONCE_BYTES);
  crypto.getRandomValues(raw);
  return Buffer.from(raw).toString("base64url");
}

/**
 * Per-connection state, keyed by socket. Tracks the handshake phase, the issued
 * challenge (so we bind `authenticate` to exactly the nonce we sent), liveness
 * timers, and — once authenticated — the {@link HubConnection} the hub owns.
 */
export interface ConnState {
  /** True once `authenticate` has succeeded. */
  authenticated: boolean;
  /** The challenge nonce we issued on connect (the only one we'll accept). */
  challengeNonce: string;
  /** Absolute expiry of the challenge nonce (epoch ms). */
  challengeExpiresAt: number;
  /** Whether the challenge nonce has been consumed by a successful auth. */
  challengeUsed: boolean;
  /** The authenticated identity, set on success (for diagnostics/logging). */
  actor?: string;
  /**
   * The authenticated actor's handle **in this provider's namespace** — set ONLY
   * when the actor's home domain is this provider (§8.5 allows a REMOTE actor to
   * connect here directly, and its bare handle belongs to its own provider's
   * namespace, where it may collide with a local user's). It is therefore the
   * only value usable as a key into provider-local storage (`presence`,
   * `dm_conversations.owner`, …); `undefined` for a remote actor, whose
   * provider-local state lives at their home provider. Mirrors
   * `AuthenticatedActor.localHandle` on the HTTP side — see its doc for the rule.
   */
  localHandle?: string;
  /** Key id that verified the handshake. */
  keyId?: string;
  /**
   * For a REMOTE actor only: what keeps its device key confirmed under the §4.6
   * cache rules (§7.1 "Close codes"; see `remote-key-watch.ts`).
   */
  remoteKey?: RemoteKeyWatch;
  /**
   * The server is closing this connection (credentials revoked, §4.7 / #15).
   * Set before the close so no further command from it is processed.
   */
  terminated: boolean;
  /** The hub registration for this connection (after auth). */
  hubConn?: HubConnection;
  /** Last time we saw inbound traffic (any frame), epoch ms — liveness basis. */
  lastSeen: number;
  /** Timer that closes the connection if `authenticate` never arrives. */
  authTimer?: ReturnType<typeof setTimeout>;
  /** Periodic server-`ping` + idle-timeout sweep. */
  heartbeatTimer?: ReturnType<typeof setInterval>;
  /**
   * Active typing indicators for THIS connection, keyed by channel id. Each
   * entry is the auto-expiry timer that fans out a `stop` if no refreshing
   * `typing.start` arrives within {@link Config.typingTimeoutMs}. A new
   * `typing.start` resets the channel's timer; an explicit `typing.stop`,
   * expiry, or disconnect removes the entry. Ephemeral — never persisted.
   */
  typingTimers: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * Active DM typing indicators for THIS connection, keyed by `dmId`. Like
   * {@link typingTimers} but DM-scoped: each entry holds the auto-expiry timer
   * and the `counterparty` actor to fan a `dm.typing` stop to (§7.4). Ephemeral.
   */
  dmTypingTimers: Map<string, { timer: ReturnType<typeof setTimeout>; counterparty: string }>;
}

/**
 * The per-event control surface Hono hands each WS handler (`WSContext`): a
 * `send`/`close` pair plus `.raw`, the **stable** underlying Bun
 * `ServerWebSocket`. A fresh `WSContext` is created per event, so we key
 * per-connection state on `.raw` and store `.raw` (a {@link HubSocket}) in the
 * hub for fan-out across events.
 */
export interface WsContext {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /**
   * Stable underlying socket; identity key + fan-out target. Hono types this as
   * `unknown`; we narrow it to a {@link HubSocket} at the few use sites.
   */
  readonly raw?: unknown;
}

/** Narrow a WSContext's `raw` socket to the {@link HubSocket} we send through. */
export function rawSocket(ws: WsContext): HubSocket | undefined {
  return ws.raw as HubSocket | undefined;
}

/**
 * Build an `error` event payload (matches `WsErrorSchema`). §7.3: the event's
 * `code` MUST be an `errorCode` and its `status` the matching HTTP status, so
 * `code` is typed to the registry and `status` is DERIVED from it — a mismatched
 * pair (or an off-registry code like `rate_limited`) cannot be expressed.
 */
export function errorEvent(
  code: RegistryErrorCode,
  message: string,
  correlationId?: string,
): OutboundEvent {
  return {
    type: "error",
    ...(correlationId !== undefined ? { correlationId } : {}),
    data: { code, message, status: errorCodeStatus(code) },
  };
}

/**
 * What every WS handler runs against: the injected dependencies plus values
 * derived once per handler set (resolved timings, this provider's canonical
 * authority, the challenge-nonce generator).
 */
export interface WsCtx {
  readonly config: Config;
  readonly db: Db;
  readonly hub: Hub;
  readonly presenceRegistry: PresenceRegistry;
  readonly userKeysCache: RemoteUserKeysCache;
  readonly federationFetch: FederationFetch;
  readonly nonceStore: NonceStore;
  readonly timings: WsTimings;
  /** This provider's canonical authority — what `authenticate` signatures bind. */
  readonly authority: string;
  readonly issueChallengeNonce: () => string;
}

/** A command handler: the parsed-envelope frame of an authenticated connection. */
export type CommandHandler = (
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
) => void;

/**
 * End an authenticated session from the server side: stop processing its
 * commands, drop it from the hub and presence fan-out at once, send an `error`
 * (`unauthorized`, uncorrelated) and close with `code` — `4003` when its
 * credentials were revoked (see `provider/access-revocation.ts`), `4001` when a
 * remote key can no longer be confirmed or its provider is now denied
 * (`remote-key-watch.ts`). The regular `onClose` teardown still runs
 * afterwards. Idempotent.
 */
export function terminate(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  code: number,
  reason: string,
): void {
  const { hub, presenceRegistry } = ctx;
  if (state.terminated) return;
  state.terminated = true;
  const hubConn = state.hubConn;
  if (hubConn) {
    presenceRegistry.removeConnection(hubConn);
    hub.remove(hubConn);
  }
  hub.send(ws, errorEvent("unauthorized", reason));
  ws.close(code, reason);
}
