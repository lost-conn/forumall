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
 *  - `subscriptions.ts`, `messages.ts`, `reactions.ts`, `typing.ts`,
 *    `presence.ts`         — the post-auth commands.
 *
 * The endpoint is mounted at `GET /api/ws` and upgraded via Bun's WebSocket
 * support (`createBunWebSocket` from `hono/bun`). Per-connection state lives in
 * {@link ConnState}, keyed by the socket in a {@link WeakMap}, so an evicted
 * socket's state is collected automatically.
 *
 * ## Handshake ordering (§7.1 Authentication) — strict
 *  1. On open, the server issues an `auth.challenge` event FIRST, with a fresh
 *     ≥128-bit nonce and an `expiresAt` ~30s out, recorded on the connection.
 *  2. The client's FIRST command MUST be `authenticate`. Any other command
 *     before auth closes the connection. No valid `authenticate` within ~10s
 *     closes the connection.
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
 *     the hub. On failure → an `error` event then close code 4001.
 *
 * After auth, unknown command types are ignored (open-world, §2.3); malformed
 * frames get an `error` event.
 */
import { WsEnvelopeSchema, canonicalAuthority } from "@forumall/shared";
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
  type WsContext,
  type WsCtx,
  type WsTimings,
  errorEvent,
  mintChallengeNonce,
  rawSocket,
} from "./ws/connection.ts";
import { handleMessageCreate, handleMessageDelete, handleMessageUpdate } from "./ws/messages.ts";
import {
  handlePresenceSet,
  handlePresenceSubscribe,
  handlePresenceUnsubscribe,
} from "./ws/presence.ts";
import { handleReactionAdd, handleReactionRemove } from "./ws/reactions.ts";
import { checkRemoteKey, stopRemoteKeyWatch } from "./ws/remote-key-watch.ts";
import { handleSubscribe, handleUnsubscribe } from "./ws/subscriptions.ts";
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
 * The post-auth commands (§7.1, §7.5), by envelope `type`. A type not listed —
 * known-but-not-implemented or unknown — is ignored after auth (open-world,
 * §2.3). `authenticate`, `ping` and `pong` are handled inline by `onMessage`.
 */
const COMMANDS: Readonly<Record<string, CommandHandler>> = {
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

/**
 * Build the Hono WS route handlers (`open`/`message`/`close`) for `upgradeWebSocket`.
 * Returned as a factory so `upgradeWebSocket(() => handlers)` can pass it
 * straight to the route, while the closure captures `deps` + per-socket state.
 */
export function createWsHandlers(deps: WsHandlerDeps) {
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
  };
  const { config, db, hub, presenceRegistry, nonceStore, timings } = ctx;

  // Per-socket state, keyed on the stable `ws.raw` so a fresh per-event
  // WSContext still resolves to one connection. Weak so a GC'd socket drops it.
  const stateBySocket = new WeakMap<object, ConnState>();

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
    // Emit a `stop` for every channel this connection was typing in BEFORE we
    // drop it from the hub (so the fan-out still reaches the channel's other
    // subscribers), then clear its timers (§7.1: a dropped connection must not
    // leave a stuck indicator).
    clearAllTyping(ctx, state, true);
    clearAllDmTyping(ctx, state, true);
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
        typingTimers: new Map(),
        dmTypingTimers: new Map(),
      };
      stateBySocket.set(keyOf(ws), state);

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
          ws.close(WS_CLOSE_AUTH_FAILED, "idle timeout");
          return;
        }
        // Only ping authenticated connections; pre-auth liveness is the
        // auth-timeout's job.
        if (state.authenticated) send(ws, { type: "ping", data: {} });
        checkRemoteKey(ctx, ws, state);
      }, timings.pingIntervalMs);
    },

    /** On every inbound frame: parse the envelope and dispatch by phase. */
    onMessage(evt: { data: unknown }, ws: WsContext): void {
      const state = stateBySocket.get(keyOf(ws));
      // A connection being closed for revoked credentials processes nothing more.
      if (!state || state.terminated) return;
      state.lastSeen = Date.now();

      // --- Parse the envelope (open-world) -----------------------------------
      const text =
        typeof evt.data === "string"
          ? evt.data
          : evt.data instanceof ArrayBuffer
            ? Buffer.from(evt.data).toString("utf8")
            : String(evt.data);
      let raw_json: unknown;
      try {
        raw_json = JSON.parse(text);
      } catch {
        send(ws, errorEvent("bad_request", "frame is not valid JSON"));
        return;
      }
      const parsed = WsEnvelopeSchema.safeParse(raw_json);
      if (!parsed.success) {
        send(ws, errorEvent("bad_request", "frame does not match the WS envelope"));
        return;
      }
      const envelope = parsed.data;
      const type = envelope.type;

      // --- Pre-auth phase (§7.1): only `authenticate` is allowed -------------
      if (!state.authenticated) {
        if (type !== "authenticate") {
          // Any other command before auth → close the connection (§7.1).
          ws.close(WS_CLOSE_AUTH_FAILED, "expected authenticate first");
          return;
        }
        // Remote key resolution (§8.5 step 3) makes the handshake async; this is
        // a fire-and-forget event handler, so we don't await — `handleAuthenticate`
        // reports every outcome (ack or `error`+close) on the socket itself. A
        // thrown rejection (unexpected) falls back to an auth-failed close.
        void handleAuthenticate(ctx, ws, state, raw_json, envelope.id).catch(() => {
          if (!state.authenticated) ws.close(WS_CLOSE_AUTH_FAILED, "authentication failed");
        });
        return;
      }

      // --- Authenticated phase ----------------------------------------------
      switch (type) {
        case "authenticate":
          // Already authenticated; a second authenticate is ignored.
          return;
        case "ping":
          // §7.1 Heartbeat: reply pong echoing the ping id in correlationId.
          send(ws, { type: "pong", correlationId: envelope.id, data: {} });
          return;
        case "pong":
          // Client's reply to our ping — liveness already refreshed above.
          return;
        default: {
          // Unknown and known-but-unimplemented types are ignored after auth
          // (open-world, §2.3).
          const handler = Object.hasOwn(COMMANDS, type) ? COMMANDS[type] : undefined;
          handler?.(ctx, ws, state, raw_json, envelope.id);
          return;
        }
      }
    },

    /** On close: tear down timers + hub registration. */
    onClose(_evt: unknown, ws: WsContext): void {
      const key = keyOf(ws);
      const state = stateBySocket.get(key);
      teardown(state);
      stateBySocket.delete(key);
    },
  };
}
