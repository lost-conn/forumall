/**
 * WebSocket transport (spec §7.1) — the connection lifecycle (challenge on
 * open, heartbeat, teardown), frame parsing and command dispatch, and the
 * wiring into the connection {@link Hub}. The commands themselves live in
 * `http/ws/`:
 *  - `connection.ts`       — close codes, timings, {@link ConnState}, `WsCtx`,
 *                            `errorEvent`, `terminate`;
 *  - `authenticate.ts`     — the §7.1/§8.5 handshake;
 *  - `remote-key-watch.ts` — keeping a remote actor's key confirmed (§7.1
 *                            "Close codes": 4003 when gone, 4001 when it can no
 *                            longer be confirmed or the peer is now denied);
 *  - `dispatch.ts`         — frame decoding and command routing;
 *  - `heartbeat.ts`, `subscriptions.ts`, `messages.ts`, `reactions.ts`,
 *    `typing.ts`, `presence.ts` — the post-auth commands.
 *
 * The endpoint is mounted at `GET /api/ws` and upgraded via Bun's WebSocket
 * support (`createBunWebSocket` from `hono/bun`). Per-connection state lives in
 * {@link ConnState}, keyed by the socket in a {@link WeakMap}, so an evicted
 * socket's state is collected automatically.
 *
 * ## Handshake ordering (§7.1 Authentication) — strict
 *  1. On open, the server issues an `auth.challenge` event FIRST, with a fresh
 *     ≥128-bit nonce and an `expiresAt` ~30s out, recorded on the connection.
 *  2. The client's FIRST command MUST be `authenticate`. Any other frame
 *     before auth (including one that is not JSON or has no `type`) closes the
 *     connection with 4001. No valid `authenticate` within ~10s closes it with
 *     4001.
 *  3. `authenticate` is verified with the shared {@link verifyWsAuthenticate}
 *     over the challenge nonce we issued (timestamp skew ±300s). The
 *     `(key_id, challenge nonce)` pair is checked against — and, once accepted,
 *     recorded in — the SAME provider-wide replay store the REST signature
 *     middleware uses (`c.var.nonceStore` / {@link WsHandlerDeps.nonceStore},
 *     #21), namespaced `"actor"` (see {@link nonceKeyId}: WS only ever
 *     authenticates a user device key, never a provider identity). This is on
 *     top of, not instead of, the per-connection `challengeUsed` one-shot check
 *     below — the shared store additionally catches a `(key_id, nonce)` pair
 *     already burned by ANOTHER connection or by a REST request. Key resolution
 *     splits on the actor's home domain: a LOCAL actor resolves a device key
 *     locally; a REMOTE actor (§8.5 step 3) resolves its key from its home
 *     provider via the §4.6 user-keys cache (with the §8 connect-time federation
 *     policy applied first). On success → `authenticated { actor }` + register in
 *     the hub. On failure → an `error` event mirroring the REST answer, then
 *     close code 4001.
 *
 * After auth (see `dispatch.ts`): a frame that is not JSON or has no `id` gets
 * an uncorrelated `bad_request`; a standard command is validated by its handler
 * (`bad_request` correlated to its `id` when malformed); unknown non-standard
 * types are ignored (open-world, §2.3).
 *
 * ## Close codes (§7.1)
 * `4001`/`4003` only for the reasons in the spec's table. Otherwise: idle
 * timeout `1000`, shutdown `1001` ({@link WsHandlers.closeAll}), oversized
 * frame `1009` (Bun, `maxPayloadLength`), connection cap `1013`.
 */
import { type WsCommandType, canonicalAuthority } from "@forumall/shared";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { FederationFetch } from "../provider/federation/http.ts";
import type { RemoteUserKeysCache } from "../provider/federation/user-keys-cache.ts";
import type { NonceStore } from "../provider/nonce-store.ts";
import { type PresenceRegistry, fanOutPresence, markLastSeen } from "../provider/presence.ts";
import type { Hub, OutboundEvent } from "../provider/ws-hub.ts";
import { handleAuthenticate } from "./ws/authenticate.ts";
import {
  type CommandHandler,
  type ConnState,
  DEFAULT_WS_TIMINGS,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_NORMAL,
  type WsContext,
  type WsCtx,
  type WsTimings,
  errorEvent,
  mintChallengeNonce,
  rawSocket,
} from "./ws/connection.ts";
import { decodeFrame, routeCommand } from "./ws/dispatch.ts";
import { handlePing, handlePong } from "./ws/heartbeat.ts";
import { handleMessageCreate, handleMessageDelete, handleMessageUpdate } from "./ws/messages.ts";
import {
  handlePresenceSet,
  handlePresenceSubscribe,
  handlePresenceUnsubscribe,
} from "./ws/presence.ts";
import { handleReactionAdd, handleReactionRemove } from "./ws/reactions.ts";
import { checkRemoteKey, stopRemoteKeyWatch } from "./ws/remote-key-watch.ts";
import { handleSubscribe, handleUnsubscribe } from "./ws/subscriptions.ts";
import { TypingRegistry } from "./ws/typing-registry.ts";
import {
  clearAllDmTyping,
  clearAllTyping,
  handleTypingStart,
  handleTypingStop,
} from "./ws/typing.ts";

export {
  DEFAULT_WS_TIMINGS,
  WS_CLOSE_AUTH_FAILED,
  type WsTimings,
  errorEvent,
} from "./ws/connection.ts";

/**
 * Dependencies the WS handler needs, threaded from `app.ts`. The hub is shared
 * with the rest of the app so later cards can publish to the same connections.
 */
export interface WsHandlerDeps {
  readonly config: Config;
  readonly db: Db;
  readonly hub: Hub;
  /** Shared presence-subscription registry (§7.5). */
  readonly presenceRegistry: PresenceRegistry;
  /**
   * Shared remote user-keys cache (§4.6). Used by the WS handshake to resolve a
   * **remote** actor's `authenticate` key from the actor's home provider (§8.5
   * step 3), with a forced re-fetch on a verify miss for key rotation/revocation.
   */
  readonly userKeysCache: RemoteUserKeysCache;
  /**
   * Injectable outbound federation fetch (§8). Threaded so the §10 notification
   * delivery fired from the `message.create` fan-out reaches the same transport
   * the rest of federation uses (and so tests can point a `target` at an
   * in-process receiver). Defaults via `app.ts` to the global-`fetch` transport.
   */
  readonly federationFetch: FederationFetch;
  /**
   * Provider-wide replay/nonce store (§4.5 step 4, §8; #21) — the SAME instance
   * `app.ts` hands to every REST `requireSignature()`/`optionalSignature()`
   * middleware, so a `(key_id, nonce)` pair burned by a REST request or by
   * another WS connection is rejected here too. See the module header and the
   * module doc on `provider/nonce-store.ts`.
   */
  readonly nonceStore: NonceStore;
  /** Heartbeat/handshake timings; defaults to {@link DEFAULT_WS_TIMINGS}. */
  readonly timings?: Partial<WsTimings>;
  /**
   * Override the challenge-nonce generator. Test-only: lets a test force two
   * connections to receive the SAME challenge nonce, to exercise the
   * provider-wide replay guard above deterministically (a real ≥128-bit random
   * collision is not something a test can wait for). Defaults to
   * {@link mintChallengeNonce}.
   */
  readonly mintChallengeNonce?: () => string;
}

/**
 * The post-auth commands (§7.1, §7.5), by envelope `type`. Typed over every
 * standard command but `authenticate` (handled by `onMessage`), so a standard
 * command added to the shared schema cannot be left without a handler here.
 */
const COMMANDS: Readonly<Record<Exclude<WsCommandType, "authenticate">, CommandHandler>> = {
  ping: handlePing,
  pong: handlePong,
  subscribe: handleSubscribe,
  unsubscribe: handleUnsubscribe,
  "message.create": handleMessageCreate,
  "message.update": handleMessageUpdate,
  "message.delete": handleMessageDelete,
  "reaction.add": handleReactionAdd,
  "reaction.remove": handleReactionRemove,
  "typing.start": handleTypingStart,
  "typing.stop": handleTypingStop,
  "presence.subscribe": handlePresenceSubscribe,
  "presence.unsubscribe": handlePresenceUnsubscribe,
  "presence.set": handlePresenceSet,
};

/** The Hono WS route handlers, plus the provider-side shutdown close. */
export interface WsHandlers {
  onOpen(evt: unknown, ws: WsContext): void;
  onMessage(evt: { data: unknown }, ws: WsContext): void;
  onClose(evt: unknown, ws: WsContext): void;
  /**
   * Close every open connection, authenticated or not, with `code` — `1001`
   * on provider shutdown or restart (§7.1 "Close codes"). Their regular
   * `onClose` teardown runs as each socket closes.
   */
  closeAll(code: number, reason: string): void;
}

/**
 * Build the Hono WS route handlers (`open`/`message`/`close`) for `upgradeWebSocket`.
 * Returned as a factory so `upgradeWebSocket(() => handlers)` can pass it
 * straight to the route, while the closure captures `deps` + per-socket state.
 */
export function createWsHandlers(deps: WsHandlerDeps): WsHandlers {
  const ctx: WsCtx = {
    config: deps.config,
    db: deps.db,
    hub: deps.hub,
    presenceRegistry: deps.presenceRegistry,
    userKeysCache: deps.userKeysCache,
    federationFetch: deps.federationFetch,
    nonceStore: deps.nonceStore,
    timings: { ...DEFAULT_WS_TIMINGS, ...deps.timings },
    authority: canonicalAuthority(deps.config.domain),
    issueChallengeNonce: deps.mintChallengeNonce ?? mintChallengeNonce,
    channelTyping: new TypingRegistry(),
    dmTyping: new TypingRegistry(),
  };
  const { config, db, hub, presenceRegistry, nonceStore, timings } = ctx;

  // Per-socket state, keyed on the stable `ws.raw` so a fresh per-event
  // WSContext still resolves to one connection. Weak so a GC'd socket drops it.
  const stateBySocket = new WeakMap<object, ConnState>();
  // Every open connection, for {@link WsHandlers.closeAll}. Keyed like
  // `stateBySocket`; entries leave on close.
  const openSockets = new Map<object, WsContext>();

  /** Resolve the stable identity/state key for a per-event WSContext. */
  function keyOf(ws: WsContext): object {
    return (rawSocket(ws) ?? ws) as object;
  }

  /** Send an event to a connection via the hub (stamps id/ts, serializes). */
  function send(ws: WsContext, event: OutboundEvent): void {
    hub.send(ws, event);
  }

  /** Tear down timers + hub registration for a connection. Idempotent. */
  function teardown(state: ConnState | undefined): void {
    if (!state) return;
    state.closed = true;
    if (state.authTimer) clearTimeout(state.authTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    // Drop this connection's typing starts BEFORE removing it from the hub, so
    // the `stop` fanned out where the actor no longer types still reaches the
    // channel's other subscribers (§7.1: a dropped connection must not leave a
    // stuck indicator).
    clearAllTyping(ctx, state);
    clearAllDmTyping(ctx, state);
    stopRemoteKeyWatch(state);

    const hubConn = state.hubConn;
    if (hubConn) {
      // Purge THIS connection's presence subscriptions so it no longer receives
      // fan-out (and the subject sets shrink), then drop it from the hub.
      presenceRegistry.removeConnection(hubConn);
      hub.remove(hubConn);
      // §7.5 connection-derived offline: if this was the actor's LAST live
      // connection, stamp `lastSeen` and fan out an `offline` presence.update.
      // We check AFTER `hub.remove` so the live-connection count excludes this
      // connection (a remaining device keeps the actor online).
      // LOCAL actors only: `presence` rows are keyed on a local handle, and a
      // remote actor's presence is owned by their home provider (§7.5/§8.5).
      if (state.localHandle && hub.liveConnectionCount(hubConn.actor) === 0) {
        markLastSeen(db, state.localHandle);
        fanOutPresence(db, hub, config, presenceRegistry, state.localHandle);
      }
    }
  }

  return {
    /**
     * On connect (§7.1 step 1): issue the `auth.challenge` FIRST, arm the
     * auth-timeout, and start the heartbeat sweep.
     */
    onOpen(_evt: unknown, ws: WsContext): void {
      const nonce = ctx.issueChallengeNonce();
      // Challenge expiry and the authenticate timestamp check use the replay
      // store's clock, like the REST verifier (§4.5: one clock).
      const now = nonceStore.now();
      const state: ConnState = {
        authenticated: false,
        challengeNonce: nonce,
        challengeExpiresAt: now + timings.challengeTtlMs,
        challengeUsed: false,
        lastSeen: now,
        terminated: false,
        closed: false,
      };
      stateBySocket.set(keyOf(ws), state);
      openSockets.set(keyOf(ws), ws);

      // §7.1 step 1: the challenge MUST be the first frame the client sees.
      send(ws, {
        type: "auth.challenge",
        data: { nonce, expiresAt: new Date(state.challengeExpiresAt).toISOString() },
      });

      // Close if no valid `authenticate` within the window (§7.1).
      state.authTimer = setTimeout(() => {
        if (!state.authenticated) ws.close(WS_CLOSE_AUTH_FAILED, "authenticate timeout");
      }, timings.authTimeoutMs);

      // Heartbeat: periodically ping and close on idle (§7.1 Heartbeat).
      state.heartbeatTimer = setInterval(() => {
        if (Date.now() - state.lastSeen > timings.idleTimeoutMs) {
          // §7.1: an idle close is a normal close, never 4001 (which would
          // tell the client its authentication failed).
          ws.close(WS_CLOSE_NORMAL, "idle timeout");
          return;
        }
        // Only ping authenticated connections; pre-auth liveness is the
        // auth-timeout's job.
        if (state.authenticated) send(ws, { type: "ping", data: {} });
        checkRemoteKey(ctx, ws, state);
      }, timings.pingIntervalMs);
    },

    /** On every inbound frame: decode it and dispatch by phase. */
    onMessage(evt: { data: unknown }, ws: WsContext): void {
      const state = stateBySocket.get(keyOf(ws));
      // A connection being closed for revoked credentials processes nothing more.
      if (!state || state.terminated) return;
      state.lastSeen = Date.now();
      const frame = decodeFrame(evt.data);

      // --- Pre-auth phase (§7.1): only `authenticate` is allowed -------------
      if (!state.authenticated) {
        if (frame.kind !== "frame" || frame.type !== "authenticate") {
          // Any other frame before auth → close 4001 (§7.1 Authentication).
          ws.close(WS_CLOSE_AUTH_FAILED, "expected authenticate first");
          return;
        }
        // Remote key resolution (§8.5 step 3) makes the handshake async; this is
        // a fire-and-forget event handler, so we don't await — `handleAuthenticate`
        // reports every outcome (ack or `error`+close) on the socket itself. A
        // thrown rejection (unexpected) falls back to an auth-failed close.
        void handleAuthenticate(ctx, ws, state, frame.json, frame.id).catch(() => {
          if (!state.authenticated) ws.close(WS_CLOSE_AUTH_FAILED, "authentication failed");
        });
        return;
      }

      // --- Authenticated phase ----------------------------------------------
      if (frame.kind === "invalid_json") {
        send(ws, errorEvent("bad_request", "frame is not valid JSON"));
        return;
      }
      if (frame.id === undefined) {
        // §7.1: nothing to correlate, so the error carries no correlationId.
        send(ws, errorEvent("bad_request", "command has no id"));
        return;
      }
      if (frame.type === undefined) {
        send(ws, errorEvent("bad_request", "command has no type", frame.id));
        return;
      }
      // Already authenticated; a second authenticate is ignored.
      if (frame.type === "authenticate") return;
      const route = routeCommand(frame.type, COMMANDS);
      switch (route.kind) {
        case "handler":
          route.handler(ctx, ws, state, frame.json, frame.id);
          return;
        case "unsupported":
          send(ws, errorEvent("bad_request", `command ${frame.type} is not supported`, frame.id));
          return;
        case "ignore":
          return;
      }
    },

    /** On close: tear down timers + hub registration. */
    onClose(_evt: unknown, ws: WsContext): void {
      const key = keyOf(ws);
      const state = stateBySocket.get(key);
      teardown(state);
      stateBySocket.delete(key);
      openSockets.delete(key);
    },

    closeAll(code: number, reason: string): void {
      for (const ws of [...openSockets.values()]) ws.close(code, reason);
    },
  };
}
