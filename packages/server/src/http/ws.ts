/**
 * WebSocket transport (spec §7.1) — the signed-challenge handshake, subscribe /
 * unsubscribe authorization, heartbeat, and the wiring into the connection
 * {@link Hub}. This is the real-time backbone; message posting / fan-out,
 * reactions, typing indicators and resume (`since`) build on the hub exposed
 * here; presence, DM and calls are LATER cards.
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
 *     over the challenge nonce we issued (timestamp skew ±300s). Key resolution
 *     splits on the actor's home domain: a LOCAL actor resolves a device key
 *     locally; a REMOTE actor (§8.5 step 3) resolves its key from its home
 *     provider via the §4.6 user-keys cache (with the §8 connect-time federation
 *     policy applied first). On success → `authenticated { actor }` + register in
 *     the hub. On failure → an `error` event then close code 4001.
 *
 * After auth, unknown command types are ignored (open-world, §2.3); malformed
 * frames get an `error` event.
 */
import {
  AttachmentSchema,
  type Message,
  MessageKindSchema,
  MessageReferenceSchema,
  WsAuthenticateSchema,
  WsChannelTypingSchema,
  WsDmTypingSchema,
  WsEnvelopeSchema,
  WsMessageCreateSchema,
  WsMessageCreatedSchema,
  WsMessageDeleteSchema,
  WsMessageDeletedSchema,
  WsMessageUpdateSchema,
  WsMessageUpdatedSchema,
  WsPresenceSetSchema,
  WsPresenceSubscribeSchema,
  WsPresenceSubscribedSchema,
  WsPresenceUnsubscribeSchema,
  WsPresenceUnsubscribedSchema,
  WsReactionAddSchema,
  WsReactionAddedSchema,
  WsReactionRemoveSchema,
  WsReactionRemovedSchema,
  WsSubscribeSchema,
  WsTypingStartSchema,
  WsTypingStopSchema,
  WsUnsubscribeSchema,
  canonicalAuthority,
  isKnownWsType,
  rfc3339Timestamp,
  verifyWsAuthenticate,
} from "@forumall/shared";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { canViewChannel, getChannelRow } from "../provider/channels.ts";
import { resolveActorKeys } from "../provider/device-keys.ts";
import { getDmConversationRow, isDmParticipant } from "../provider/dms.ts";
import type { FederationFetch } from "../provider/federation/http.ts";
import { isProviderAllowed } from "../provider/federation/policy.ts";
import type { RemoteUserKeysCache } from "../provider/federation/user-keys-cache.ts";
import {
  type MessageRecord,
  createMessage,
  decodeMessageCursor,
  getMessageByClientId,
  resumeMessages,
  tombstoneMessage,
  updateMessageContent,
} from "../provider/messages.ts";
import { deliverNotification, groupMemberActors } from "../provider/notifications.ts";
import {
  type PresenceRegistry,
  fanOutPresence,
  filterPresenceFor,
  markLastSeen,
  presenceUpdateEvent,
  setExplicitPresence,
  toPresence,
} from "../provider/presence.ts";
import { addReaction, removeReaction } from "../provider/reactions.ts";
import type { Hub, HubConnection, HubSocket, OutboundEvent } from "../provider/ws-hub.ts";
import {
  authorizeChannelPost,
  authorizeMessageDelete,
  authorizeMessageEdit,
  authorizeReaction,
} from "./message-mutations.ts";

/** Application close code for an authentication failure (§7.1). */
export const WS_CLOSE_AUTH_FAILED = 4001;

/** Allowed ±skew for the `authenticate` timestamp, seconds (§4.5 step 3). */
const TIMESTAMP_SKEW_SECONDS = 300;

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
}

/** §7.1 RECOMMENDED defaults. */
export const DEFAULT_WS_TIMINGS: WsTimings = {
  authTimeoutMs: 10_000,
  challengeTtlMs: 30_000,
  pingIntervalMs: 30_000,
  idleTimeoutMs: 60_000,
};

/** Random bytes for a challenge nonce (16 = 128 bits, §7.1 "≥128-bit"). */
const CHALLENGE_NONCE_BYTES: number = 16;

/** Mint a ≥128-bit base64url challenge nonce. */
function mintChallengeNonce(): string {
  const raw = new Uint8Array(CHALLENGE_NONCE_BYTES);
  crypto.getRandomValues(raw);
  return Buffer.from(raw).toString("base64url");
}

/** RFC 3339 timestamp helper local to this module (avoids an extra import). */
function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Per-connection state, keyed by socket. Tracks the handshake phase, the issued
 * challenge (so we bind `authenticate` to exactly the nonce we sent), liveness
 * timers, and — once authenticated — the {@link HubConnection} the hub owns.
 */
interface ConnState {
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
  /** Handle of the authenticated actor. */
  handle?: string;
  /** Key id that verified the handshake. */
  keyId?: string;
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
interface WsContext {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /**
   * Stable underlying socket; identity key + fan-out target. Hono types this as
   * `unknown`; we narrow it to a {@link HubSocket} at the few use sites.
   */
  readonly raw?: unknown;
}

/** Narrow a WSContext's `raw` socket to the {@link HubSocket} we send through. */
function rawSocket(ws: WsContext): HubSocket | undefined {
  return ws.raw as HubSocket | undefined;
}

/** Build an `error` event payload (matches `WsErrorSchema`). */
function errorEvent(
  code: string,
  message: string,
  status: number,
  correlationId?: string,
): OutboundEvent {
  return {
    type: "error",
    ...(correlationId !== undefined ? { correlationId } : {}),
    data: { code, message, status },
  };
}

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
  /** Heartbeat/handshake timings; defaults to {@link DEFAULT_WS_TIMINGS}. */
  readonly timings?: Partial<WsTimings>;
}

/**
 * Build the Hono WS route handlers (`open`/`message`/`close`) for `upgradeWebSocket`.
 * Returned as a factory so `upgradeWebSocket(() => handlers)` can pass it
 * straight to the route, while the closure captures `deps` + per-socket state.
 */
export function createWsHandlers(deps: WsHandlerDeps) {
  const { config, db, hub, presenceRegistry, userKeysCache, federationFetch } = deps;
  const timings: WsTimings = { ...DEFAULT_WS_TIMINGS, ...deps.timings };
  const authority = canonicalAuthority(config.domain);

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

  /** Build a validated `channel.typing` event (§7.1 "Typing indicators"). */
  function typingEvent(
    channelId: string,
    user: string,
    typingState: "start" | "stop",
  ): OutboundEvent {
    return {
      type: "channel.typing",
      data: WsChannelTypingSchema.shape.data.parse({ channelId, user, state: typingState }),
    };
  }

  /**
   * Clear a connection's typing timer for `channelId` without fanning out. Used
   * on explicit stop (we fan out separately) and when resetting on refresh.
   */
  function clearTypingTimer(state: ConnState, channelId: string): void {
    const timer = state.typingTimers.get(channelId);
    if (timer !== undefined) {
      clearTimeout(timer);
      state.typingTimers.delete(channelId);
    }
  }

  /** Build a validated `dm.typing` event (§7.4, mirrors `channel.typing`). */
  function dmTypingEvent(dmId: string, user: string, typingState: "start" | "stop"): OutboundEvent {
    return {
      type: "dm.typing",
      data: WsDmTypingSchema.shape.data.parse({ dmId, user, state: typingState }),
    };
  }

  /** Clear a connection's DM typing timer for `dmId` without fanning out. */
  function clearDmTypingTimer(state: ConnState, dmId: string): void {
    const entry = state.dmTypingTimers.get(dmId);
    if (entry !== undefined) {
      clearTimeout(entry.timer);
      state.dmTypingTimers.delete(dmId);
    }
  }

  /**
   * Clear every active DM typing indicator for a connection, optionally fanning
   * out a `stop` to each counterparty first (on disconnect, so a dropped
   * connection never leaves a stuck indicator — mirrors {@link clearAllTyping}).
   */
  function clearAllDmTyping(state: ConnState, emitStop: boolean): void {
    for (const [dmId, entry] of state.dmTypingTimers) {
      clearTimeout(entry.timer);
      if (emitStop && state.actor) {
        hub.publishToActor(entry.counterparty, dmTypingEvent(dmId, state.actor, "stop"));
      }
    }
    state.dmTypingTimers.clear();
  }

  /**
   * Clear every active typing indicator for a connection, optionally fanning out
   * a `stop` for each first. On disconnect (`emitStop`) we MUST emit a `stop` per
   * channel the actor was typing in, so a dropped connection never leaves an
   * indicator stuck (§7.1). On a clean teardown after the hub is gone we still
   * clear the timers so none leak past the connection.
   */
  function clearAllTyping(state: ConnState, emitStop: boolean): void {
    for (const [channelId, timer] of state.typingTimers) {
      clearTimeout(timer);
      if (emitStop && state.actor) {
        hub.publishToChannel(channelId, typingEvent(channelId, state.actor, "stop"));
      }
    }
    state.typingTimers.clear();
  }

  /** Tear down timers + hub registration for a connection. Idempotent. */
  function teardown(state: ConnState | undefined): void {
    if (!state) return;
    if (state.authTimer) clearTimeout(state.authTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    // Emit a `stop` for every channel this connection was typing in BEFORE we
    // drop it from the hub (so the fan-out still reaches the channel's other
    // subscribers), then clear its timers (§7.1: a dropped connection must not
    // leave a stuck indicator).
    clearAllTyping(state, true);
    clearAllDmTyping(state, true);

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
      if (state.handle && hub.liveConnectionCount(hubConn.actor) === 0) {
        markLastSeen(db, state.handle);
        fanOutPresence(db, hub, config, presenceRegistry, state.handle);
      }
    }
  }

  return {
    /**
     * On connect (§7.1 step 1): issue the `auth.challenge` FIRST, arm the
     * auth-timeout, and start the heartbeat sweep.
     */
    onOpen(_evt: unknown, ws: WsContext): void {
      const nonce = mintChallengeNonce();
      const now = Date.now();
      const state: ConnState = {
        authenticated: false,
        challengeNonce: nonce,
        challengeExpiresAt: now + timings.challengeTtlMs,
        challengeUsed: false,
        lastSeen: now,
        typingTimers: new Map(),
        dmTypingTimers: new Map(),
      };
      stateBySocket.set(keyOf(ws), state);

      // §7.1 step 1: the challenge MUST be the first frame the client sees.
      send(ws, {
        type: "auth.challenge",
        data: { nonce, expiresAt: isoNow(timings.challengeTtlMs) },
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
      }, timings.pingIntervalMs);
    },

    /** On every inbound frame: parse the envelope and dispatch by phase. */
    onMessage(evt: { data: unknown }, ws: WsContext): void {
      const state = stateBySocket.get(keyOf(ws));
      if (!state) return;
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
        send(ws, errorEvent("bad_request", "frame is not valid JSON", 400));
        return;
      }
      const parsed = WsEnvelopeSchema.safeParse(raw_json);
      if (!parsed.success) {
        send(ws, errorEvent("bad_request", "frame does not match the WS envelope", 400));
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
        void handleAuthenticate(ws, state, raw_json, envelope.id).catch(() => {
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
        case "subscribe":
          handleSubscribe(ws, state, raw_json, envelope.id);
          return;
        case "unsubscribe":
          handleUnsubscribe(ws, state, raw_json, envelope.id);
          return;
        case "message.create":
          handleMessageCreate(ws, state, raw_json, envelope.id);
          return;
        case "message.update":
          handleMessageUpdate(ws, state, raw_json, envelope.id);
          return;
        case "message.delete":
          handleMessageDelete(ws, state, raw_json, envelope.id);
          return;
        case "reaction.add":
          handleReactionAdd(ws, state, raw_json, envelope.id);
          return;
        case "reaction.remove":
          handleReactionRemove(ws, state, raw_json, envelope.id);
          return;
        case "typing.start":
          handleTypingStart(ws, state, raw_json, envelope.id);
          return;
        case "typing.stop":
          handleTypingStop(ws, state, raw_json, envelope.id);
          return;
        case "presence.subscribe":
          handlePresenceSubscribe(ws, state, raw_json, envelope.id);
          return;
        case "presence.unsubscribe":
          handlePresenceUnsubscribe(ws, state, raw_json, envelope.id);
          return;
        case "presence.set":
          handlePresenceSet(ws, state, raw_json, envelope.id);
          return;
        default:
          // Known-but-not-yet-implemented (message.create, reaction.*, …) and
          // unknown types are both ignored after auth (open-world, §2.3). A
          // future card adds its case here.
          void isKnownWsType(type);
          return;
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

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  /**
   * §7.1 + §8.5 Authentication: verify the signed challenge and register the
   * connection.
   *
   * ## Local vs remote key resolution (§8.5 step 3)
   * The `authenticate` canonical string binds the **home provider being connected
   * to** — i.e. THIS provider's `config.domain` (`authority`) — regardless of the
   * actor's origin (§8.5). Key resolution splits on the actor's home domain:
   *  - **Local** actor (`handle@<this host>`) → {@link resolveActorKeys} as before.
   *  - **Remote** actor (a different home provider) → resolve the device key from
   *    the actor's home provider via {@link RemoteUserKeysCache} (§4.6); on a
   *    verify miss for a key believed valid, force one cache re-fetch and retry,
   *    so rotation/revocation is picked up promptly (§4.6, §8.5 step 3).
   *
   * ## Connect-time federation policy (§8.5 connection notes)
   * For a remote actor the §8 allow/deny policy ({@link isProviderAllowed}) is
   * applied at the handshake BEFORE any key fetch; a disallowed peer gets an
   * `error` then close 4001. Local actors are unaffected.
   *
   * ## Guests (§4.8)
   * Guest accounts are NOT federated and MUST NOT open a remote WS connection. In
   * this implementation guests are provider-LOCAL only (provisioned via invites,
   * §5.6/§4.8) — there is no notion of a remote guest, and the §4.6 keys-response
   * carries no guest flag, so a *remote* actor reaching this path can never be a
   * local guest. We therefore cannot cheaply detect (and so do not separately
   * refuse) a remote actor that is flagged guest at its home provider; that
   * refusal is the remote provider's MAY per §4.8. A local guest authenticating
   * here is a normal local actor and is allowed (the WS is to its own home).
   */
  async function handleAuthenticate(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): Promise<void> {
    const fail = (message: string): void => {
      send(ws, errorEvent("unauthorized", message, 401, frameId));
      ws.close(WS_CLOSE_AUTH_FAILED, "authentication failed");
    };

    const parsed = WsAuthenticateSchema.safeParse(rawFrame);
    if (!parsed.success) {
      fail("malformed authenticate command");
      return;
    }
    const { actor, keyId, timestamp, signature } = parsed.data.data;

    // §4.5 step 3: timestamp within ±skew.
    const tsMillis = Date.parse(timestamp);
    if (Number.isNaN(tsMillis) || Math.abs(Date.now() - tsMillis) > TIMESTAMP_SKEW_SECONDS * 1000) {
      fail("authenticate timestamp is outside the allowed window");
      return;
    }

    // The challenge MUST be the one we issued for THIS connection, unused +
    // unexpired (§7.1 step 3). We bind to a single per-connection nonce, so we
    // only ever compare against `state.challengeNonce`.
    if (state.challengeUsed) {
      fail("challenge nonce already used");
      return;
    }
    if (Date.now() > state.challengeExpiresAt) {
      fail("challenge nonce expired");
      return;
    }

    // Parse the actor identity (§4.5 step 6 split).
    const at = actor.lastIndexOf("@");
    if (at <= 0 || at === actor.length - 1) {
      fail("malformed actor");
      return;
    }
    const handle = actor.slice(0, at);
    const actorDomain = canonicalAuthority(actor.slice(at + 1));

    // The signature is always bound to THIS provider's authority (the home
    // provider being connected to, §8.5) — never the actor's own domain.
    const verifyWith = (publicKey: string): boolean =>
      verifyWsAuthenticate({
        publicKey,
        authority,
        challengeNonce: state.challengeNonce,
        timestamp,
        signature,
      });

    if (actorDomain === authority) {
      // --- Local actor: resolve a device key locally (§4.5 step 6) -----------
      const key = resolveActorKeys(db, handle).find((k) => k.keyId === keyId);
      if (!key) {
        fail("no active device key matches actor/keyId");
        return;
      }
      if (!verifyWith(key.publicKey)) {
        fail("invalid authenticate signature");
        return;
      }
    } else {
      // --- Remote actor (§8.5 step 3) ----------------------------------------
      // Connect-time federation policy (§8.5 connection notes): a disallowed peer
      // is rejected BEFORE any key fetch.
      if (!isProviderAllowed(config, actorDomain)) {
        fail(`federation with ${actorDomain} is not permitted by this provider's policy`);
        return;
      }

      // Resolve the actor's published device key from its home provider (§4.6),
      // verifying against it; on a miss (unknown key id *or* a key that fails to
      // verify) force one keys-endpoint re-fetch and retry, mirroring the HTTP
      // signature path so rotation/revocation is picked up promptly.
      const cached = await userKeysCache.getActorKey(actor, keyId);
      let resolved = cached != null && verifyWith(cached.publicKey);
      if (!resolved) {
        const fresh = await userKeysCache.getActorKey(actor, keyId, { forceRefresh: true });
        resolved = fresh != null && verifyWith(fresh.publicKey);
      }
      if (!resolved) {
        fail("no active remote device key matches actor/keyId, or invalid signature");
        return;
      }
    }

    // A late frame may have raced the async key resolution and already closed /
    // re-authenticated this connection; bail if so (don't double-register).
    if (state.authenticated || state.challengeUsed) {
      return;
    }

    // Success: consume the challenge, mark authenticated, register in the hub.
    state.challengeUsed = true;
    state.authenticated = true;
    state.actor = actor;
    state.handle = handle;
    state.keyId = keyId;
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = undefined;
    }
    // Store the STABLE socket (`ws.raw`) for cross-event fan-out, not the
    // per-event WSContext.
    const socket: HubSocket = rawSocket(ws) ?? ws;
    const hubConn: HubConnection = { socket, actor, subscriptions: new Set() };
    state.hubConn = hubConn;
    // Whether the actor had NO live connection before this one (→ this auth flips
    // them online). Checked BEFORE `hub.add` so the prior count excludes us.
    const wasOffline = hub.liveConnectionCount(actor) === 0;
    hub.add(hubConn);

    send(ws, { type: "authenticated", correlationId: frameId, data: { actor } });

    // §7.5 connection-derived online: the actor's first live connection flips
    // them effectively online (their explicit away/dnd, if any, is preserved by
    // `effectivePresence` reading the stored value) and fans out a
    // `presence.update` to subscribers. A second/third device does not re-fan
    // (they were already online).
    if (wasOffline) {
      fanOutPresence(db, hub, config, presenceRegistry, handle);
    }
  }

  /**
   * §7.1 Subscriptions + resume: enforce per-channel visibility (membership +
   * tier) at subscribe-time, ack the authorized ones, reject unauthorized
   * channels with a `forbidden` error, and — for any channel carrying a `since`
   * cursor — REPLAY the post-cursor timeline before any live event flows.
   *
   * ## Resume (§7.1 "Resuming after a disconnect")
   * For each authorized channel with a `since` cursor we decode it to `sinceSeq`
   * and replay every message with `seq > sinceSeq`, in ascending `seq` order, as
   * a `message.created` event carrying the message's CURRENT canonical state (so
   * an edit/delete since the cursor is reflected in the replayed copy) and its
   * `cursor`. We register the subscription FIRST, then replay synchronously —
   * the single-process hub means no live event for that channel can interleave
   * ahead of the replay, so the client sees the gap-closing replay strictly
   * before live events. (At-least-once delivery, §7.1: the boundary message MAY
   * re-appear if the client already has it; clients de-dupe by message `id`.)
   *
   * ## Truncation
   * Replay is capped at {@link Config.maxResumeReplay}. If the gap exceeds the
   * cap (or the cursor predates retention), the channel is NOT replayed; instead
   * it is reported in the `subscribed` ack's `truncated` array so the client
   * backfills via REST history (§7.2).
   *
   * ## Known limitation (within §7.1 at-least-once + §8.5 REST-backfill)
   * The cursor space is REST-history (create) order, keyed on `seq`. Edits and
   * deletes to messages AT OR BEFORE the resume cursor are NOT individually
   * replayed (they carry the original message's `seq`, which is `<= sinceSeq`, so
   * `seq > sinceSeq` excludes them). A client reconciles such older edits/deletes
   * by re-reading REST history (§7.2). Only edits/deletes to post-cursor messages
   * are reflected here, via the message's current state in the replayed copy.
   * `include`/ephemeral events (typing, presence) are never replayed.
   */
  function handleSubscribe(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsSubscribeSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed subscribe command", 400, frameId));
      return;
    }
    const hubConn = state.hubConn;
    if (!hubConn) return; // unreachable: only authenticated connections reach here

    const since = parsed.data.data.since;
    const authorized: string[] = [];
    const forbidden: string[] = [];
    // Authorized channels that carry a `since` cursor, paired with the channel's
    // groupId (needed to build the replayed `message.created` events).
    const resumable: { channelId: string; groupId: string; sinceCursor: string }[] = [];
    for (const channelId of parsed.data.data.channels) {
      // A `dm_…` target is a DM subscription (§7.4). Delivery itself uses
      // `publishToActor`, so subscribing to a dm is an explicit opt-in/ack: we
      // authorize it iff the caller is a participant (has a `dm_conversations`
      // row). No resume/replay path for DMs in v0.1.
      if (channelId.startsWith("dm_")) {
        if (state.handle && isDmParticipant(db, state.handle, channelId)) {
          authorized.push(channelId);
        } else {
          forbidden.push(channelId);
        }
        continue;
      }
      const row = getChannelRow(db, channelId);
      // Unknown channel or actor not permitted by tier/membership/view → forbidden.
      if (row && canViewChannel(db, row, state.actor)) {
        authorized.push(channelId);
        const sinceCursor = since?.[channelId];
        if (sinceCursor !== undefined) {
          resumable.push({ channelId, groupId: row.groupId, sinceCursor });
        }
      } else {
        forbidden.push(channelId);
      }
    }

    if (forbidden.length > 0) {
      send(
        ws,
        errorEvent(
          "forbidden",
          `not authorized to subscribe to: ${forbidden.join(", ")}`,
          403,
          frameId,
        ),
      );
    }
    if (authorized.length === 0) return;

    // Register the subscriptions BEFORE replaying so the single-process hub never
    // interleaves a live event ahead of the replay for a resumed channel.
    hub.subscribe(hubConn, authorized);

    // Resolve each resumable channel to either a replay set or a truncation.
    const truncated: string[] = [];
    const replays: { channelId: string; groupId: string; records: MessageRecord[] }[] = [];
    for (const { channelId, groupId, sinceCursor } of resumable) {
      const sinceSeq = decodeMessageCursor(sinceCursor);
      // A forged/garbage cursor decodes to null; treat it as "no replay" rather
      // than replaying the whole channel from the start.
      if (sinceSeq == null) continue;
      const outcome = resumeMessages(db, channelId, sinceSeq, config.maxResumeReplay);
      if (outcome.truncated) {
        truncated.push(channelId);
      } else {
        replays.push({ channelId, groupId, records: outcome.messages });
      }
    }

    // Ack first (carrying `truncated` when non-empty), then replay — the ack
    // tells the client which channels to backfill via REST before live events.
    send(ws, {
      type: "subscribed",
      correlationId: frameId,
      data: {
        channels: authorized,
        ...(truncated.length > 0 ? { truncated } : {}),
      },
    });

    // Replay each non-truncated channel's post-cursor timeline, ascending, to
    // THIS connection only (a resume is private to the resuming client).
    for (const { channelId, groupId, records } of replays) {
      for (const record of records) {
        send(ws, createdEvent(groupId, channelId, record, frameId));
      }
    }
  }

  /** §7.1: remove channels from the connection's set and ack `unsubscribed`. */
  function handleUnsubscribe(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsUnsubscribeSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed unsubscribe command", 400, frameId));
      return;
    }
    const hubConn = state.hubConn;
    if (!hubConn) return;
    const channels = parsed.data.data.channels;
    hub.unsubscribe(hubConn, channels);
    send(ws, { type: "unsubscribed", correlationId: frameId, data: { channels } });
  }

  /**
   * §7.1 Sending messages: validate the command, authorize the actor against the
   * channel (must exist + be visible + carry the group `post` permission), apply
   * `(author, channelId, clientMessageId)` idempotency, persist, then fan out
   * `message.created` to every connection subscribed to the channel — INCLUDING
   * the author's own connection (the example's author copy carries the request
   * `correlationId`).
   *
   * The author is ALWAYS the connection's authenticated actor; any `author` in
   * the client payload is ignored. Each timeline event carries the message's
   * opaque `cursor` (§7.1 resume / §7.2 history share one cursor space), placed
   * on the event `data`.
   */
  function handleMessageCreate(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsMessageCreateSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed message.create command", 400, frameId));
      return;
    }
    const hubConn = state.hubConn;
    const author = state.actor;
    if (!hubConn || !author) return; // unreachable: only authenticated connections reach here

    const { groupId, channelId, clientMessageId, content } = parsed.data.data;
    // `type` / `attachments` / `reference` are open-world passthrough on the
    // command schema; validate them here against the canonical shapes.
    const extra = parsed.data.data as Record<string, unknown>;
    const attachments = AttachmentsSchema.safeParse(extra.attachments);
    const reference = MessageReferenceSchema.safeParse(extra.reference);
    // Message kind (§5.3): default to a chat `message`; reject an unknown kind.
    const typeResult = MessageKindSchema.safeParse(extra.type ?? "message");
    if (!typeResult.success) {
      send(ws, errorEvent("bad_request", "invalid message type", 400, frameId));
      return;
    }
    const type = typeResult.data;
    const ref = reference.success ? reference.data : undefined;
    // Tags (§5.3, e.g. an article's topic tags / promote lineage marker) are an
    // open-world passthrough on the command; accept a plain string array.
    const tags = Array.isArray(extra.tags)
      ? extra.tags.filter((t): t is string => typeof t === "string")
      : undefined;

    // --- Authorization (§5.2.1) -------------------------------------------
    // The channel must exist in the named group, be readable by the actor, and
    // the actor must be permitted to post a message of this `type` (per-channel
    // overrides falling back to the group `post` action), satisfying any reply
    // qualification. Existence failures surface as forbidden (don't leak).
    const postError = authorizeChannelPost(db, groupId, channelId, author, type, ref);
    if (postError) {
      send(ws, errorEvent(postError.code, postError.message, postError.status, frameId));
      return;
    }

    // --- Idempotency: short-circuit a known duplicate ----------------------
    if (clientMessageId !== undefined) {
      const existing = getMessageByClientId(db, author, channelId, clientMessageId);
      if (existing) {
        // Duplicate re-send: reply to the REQUESTING connection only with the
        // canonical message.created; do NOT re-fan-out to everyone.
        send(ws, createdEvent(groupId, channelId, existing, frameId));
        return;
      }
    }

    // --- Persist -----------------------------------------------------------
    let record: MessageRecord;
    try {
      record = createMessage(db, config, {
        channelId,
        groupId,
        author,
        type,
        content,
        ...(attachments.success ? { attachments: attachments.data } : {}),
        ...(ref ? { reference: ref } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(clientMessageId !== undefined ? { clientMessageId } : {}),
      });
    } catch (err) {
      // Idempotency race: a concurrent create won the unique
      // (author, channelId, clientMessageId) index. Fall back to the row it
      // inserted and reply (to us only) with the canonical message.
      if (clientMessageId !== undefined && isUniqueViolation(err)) {
        const winner = getMessageByClientId(db, author, channelId, clientMessageId);
        if (winner) {
          send(ws, createdEvent(groupId, channelId, winner, frameId));
          return;
        }
      }
      throw err;
    }

    // --- Fan out -----------------------------------------------------------
    // Deliver to every subscriber of the channel, including the author's own
    // connection. The author's copy correlates to the request id (§7.1).
    hub.publishToChannel(channelId, createdEvent(groupId, channelId, record, frameId));

    // --- Notification webhooks (§10) ---------------------------------------
    // Fire-and-forget: also deliver a `message.created` notification to every
    // registered endpoint whose owner is a member of the message's group and who
    // subscribed to the event. Scoping rule: member-of-group ∧ subscribed; the
    // author is excluded (they don't need to be notified of their own message).
    // This MUST NOT block the WS fan-out, so we don't await — errors (including
    // zero-endpoint no-ops, which resolve cleanly) are logged off the promise.
    fireMessageCreatedNotifications(groupId, channelId, record, author);
  }

  /**
   * §10 fan-out hook for `message.created`. Non-blocking: builds the owner filter
   * (group members minus the author) and hands off to {@link deliverNotification}
   * without awaiting, logging any rejection. A group with no subscribed endpoints
   * resolves to an empty result (no outbound requests).
   */
  function fireMessageCreatedNotifications(
    groupId: string,
    channelId: string,
    record: MessageRecord,
    author: string,
  ): void {
    const ownerFilter = groupMemberActors(db, groupId, author);
    void deliverNotification(db, config, federationFetch, {
      event: "message.created",
      resource: { id: record.message.id, channel: channelId },
      ownerFilter,
    }).catch((err) => {
      console.error("notification delivery (message.created) failed:", err);
    });
  }

  /**
   * §7.1 Editing messages: replace a message's `content`. Only the **author** may
   * edit, and only while `permissions.editUntil` is in the future; otherwise
   * reject with 403. On success stamp `edited_at` and fan out `message.updated`
   * to every channel subscriber (the author's own copy correlates to the request
   * id). Missing message / wrong channel/group → 404; not author or window passed
   * → 403.
   */
  function handleMessageUpdate(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsMessageUpdateSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed message.update command", 400, frameId));
      return;
    }
    const actor = state.actor;
    if (!actor) return; // unreachable: only authenticated connections reach here

    const { groupId, channelId, messageId, content } = parsed.data.data;
    const outcome = authorizeMessageEdit(db, groupId, channelId, messageId, actor);
    if (outcome.error) {
      send(
        ws,
        errorEvent(outcome.error.code, outcome.error.message, outcome.error.status, frameId),
      );
      return;
    }

    const record = updateMessageContent(db, channelId, messageId, content);
    hub.publishToChannel(channelId, updatedEvent(groupId, channelId, record, frameId));
  }

  /**
   * §7.1 Deleting messages: tombstone (soft-delete) a message — keep `id`/`seq`,
   * clear `content`, set `deleted_at`. The **author** OR a member with the
   * `moderate` role may delete. On success fan out `message.deleted`. Missing
   * message / wrong channel/group → 404; not permitted → 403.
   */
  function handleMessageDelete(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsMessageDeleteSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed message.delete command", 400, frameId));
      return;
    }
    const actor = state.actor;
    if (!actor) return; // unreachable: only authenticated connections reach here

    const { groupId, channelId, messageId } = parsed.data.data;
    const outcome = authorizeMessageDelete(db, groupId, channelId, messageId, actor);
    if (outcome.error) {
      send(
        ws,
        errorEvent(outcome.error.code, outcome.error.message, outcome.error.status, frameId),
      );
      return;
    }

    const record = tombstoneMessage(db, channelId, messageId);
    const deletedAt = record.message.deletedAt ?? rfc3339Timestamp();
    hub.publishToChannel(channelId, {
      type: "message.deleted",
      data: WsMessageDeletedSchema.shape.data.parse({
        groupId,
        channelId,
        messageId,
        cursor: record.cursor,
        deletedAt,
      }),
    });
  }

  /**
   * §7.1 Reactions: add the connection actor's reaction to a message. Authz: the
   * actor must be able to SEE the channel and the message must exist
   * ({@link authorizeReaction}); there is no per-key permission gate. The add is
   * idempotent on `(message, author, key)` — a repeat add returns the existing
   * reaction. On success fan out `reaction.added` carrying the FULL `Reaction`
   * object to every channel subscriber (the author's own copy correlates to the
   * request id). Missing message / no channel access → `error` (404/403).
   */
  function handleReactionAdd(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsReactionAddSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed reaction.add command", 400, frameId));
      return;
    }
    const author = state.actor;
    if (!author) return; // unreachable: only authenticated connections reach here

    const { groupId, channelId, messageId, key, unicode, image } = parsed.data.data;
    const outcome = authorizeReaction(db, groupId, channelId, messageId, author);
    if (outcome.error) {
      send(
        ws,
        errorEvent(outcome.error.code, outcome.error.message, outcome.error.status, frameId),
      );
      return;
    }

    const reaction = addReaction(db, {
      messageId,
      channelId,
      groupId,
      author,
      key,
      ...(unicode !== undefined ? { unicode } : {}),
      ...(image !== undefined ? { image } : {}),
    });
    hub.publishToChannel(channelId, {
      type: "reaction.added",
      correlationId: frameId,
      data: WsReactionAddedSchema.shape.data.parse({ groupId, channelId, reaction }),
    });
  }

  /**
   * §7.1 Reactions: remove the connection actor's reaction `key` from a message.
   * Same visibility/existence authz as {@link handleReactionAdd}. Removal is
   * idempotent (a no-op if the actor held no such reaction). Always fan out
   * `reaction.removed { groupId, channelId, messageId, key, author }` to channel
   * subscribers (the author's own copy correlates to the request id). Missing
   * message / no channel access → `error` (404/403).
   */
  function handleReactionRemove(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsReactionRemoveSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed reaction.remove command", 400, frameId));
      return;
    }
    const author = state.actor;
    if (!author) return; // unreachable: only authenticated connections reach here

    const { groupId, channelId, messageId, key } = parsed.data.data;
    const outcome = authorizeReaction(db, groupId, channelId, messageId, author);
    if (outcome.error) {
      send(
        ws,
        errorEvent(outcome.error.code, outcome.error.message, outcome.error.status, frameId),
      );
      return;
    }

    removeReaction(db, messageId, author, key);
    hub.publishToChannel(channelId, {
      type: "reaction.removed",
      correlationId: frameId,
      data: WsReactionRemovedSchema.shape.data.parse({
        groupId,
        channelId,
        messageId,
        key,
        author,
      }),
    });
  }

  /**
   * §7.1 Typing indicators: signal that the connection's actor started typing in
   * a channel. Authorize the actor against channel visibility ({@link
   * channelVisibleTo} on the channel's group/tier) — an actor who can't see the
   * channel gets `forbidden` and NO fan-out. On success fan out `channel.typing
   * { channelId, user, state: "start" }` to every channel subscriber (matching
   * message fan-out, which includes the sender; clients filter their own user)
   * and (re)arm the per-(connection, channel) auto-expiry timer: if no refreshing
   * `typing.start` arrives within {@link Config.typingTimeoutMs}, the timer fans
   * out an automatic `stop`. Typing is ephemeral soft state — never persisted.
   */
  function handleTypingStart(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsTypingStartSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed typing.start command", 400, frameId));
      return;
    }
    const actor = state.actor;
    const handle = state.handle;
    if (!actor || !handle) return; // unreachable: only authenticated connections reach here

    const dmId = parsed.data.data.dmId;
    // --- DM-scoped typing (§7.4) ------------------------------------------
    if (dmId !== undefined) {
      const conv = getDmConversationRow(db, handle, dmId);
      if (!conv) {
        send(
          ws,
          errorEvent("forbidden", "not authorized to type in this conversation", 403, frameId),
        );
        return;
      }
      const counterparty = conv.counterparty;
      // Fan the `start` to the counterparty (the typer doesn't need its own echo
      // for a 2-party DM, mirroring how DM messages deliver to the recipient).
      hub.publishToActor(counterparty, dmTypingEvent(dmId, actor, "start"));
      // (Re)arm the per-(connection, dmId) auto-expiry timer.
      clearDmTypingTimer(state, dmId);
      const timer = setTimeout(() => {
        state.dmTypingTimers.delete(dmId);
        hub.publishToActor(counterparty, dmTypingEvent(dmId, actor, "stop"));
      }, config.typingTimeoutMs);
      state.dmTypingTimers.set(dmId, { timer, counterparty });
      return;
    }

    const channelId = parsed.data.data.channelId;
    if (channelId === undefined) {
      send(ws, errorEvent("bad_request", "typing.start needs a channelId or dmId", 400, frameId));
      return;
    }
    const channel = getChannelRow(db, channelId);
    if (!channel || !canViewChannel(db, channel, actor)) {
      send(ws, errorEvent("forbidden", "not authorized to type in this channel", 403, frameId));
      return;
    }

    // Fan out the `start` (includes the typer's own connection, like message
    // fan-out; clients drop their own user).
    hub.publishToChannel(channelId, typingEvent(channelId, actor, "start"));

    // (Re)arm the auto-expiry timer: a refreshing `typing.start` resets it.
    clearTypingTimer(state, channelId);
    const timer = setTimeout(() => {
      // Window elapsed with no refresh → auto-emit a `stop` (§7.1) and forget it.
      state.typingTimers.delete(channelId);
      hub.publishToChannel(channelId, typingEvent(channelId, actor, "stop"));
    }, config.typingTimeoutMs);
    state.typingTimers.set(channelId, timer);
  }

  /**
   * §7.1 Typing indicators: signal that the connection's actor stopped typing in
   * a channel. Cancels the auto-expiry timer (so it doesn't double-emit) and fans
   * out `channel.typing { channelId, user, state: "stop" }`. We don't gate this on
   * visibility — stopping is always safe — but a malformed frame still errors.
   */
  function handleTypingStop(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsTypingStopSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed typing.stop command", 400, frameId));
      return;
    }
    const actor = state.actor;
    const handle = state.handle;
    if (!actor || !handle) return; // unreachable: only authenticated connections reach here

    const dmId = parsed.data.data.dmId;
    if (dmId !== undefined) {
      // Resolve the counterparty (prefer the live timer's, fall back to the
      // conversation row) so an explicit stop still reaches the other party.
      const entry = state.dmTypingTimers.get(dmId);
      const counterparty =
        entry?.counterparty ?? getDmConversationRow(db, handle, dmId)?.counterparty;
      clearDmTypingTimer(state, dmId);
      if (counterparty) hub.publishToActor(counterparty, dmTypingEvent(dmId, actor, "stop"));
      return;
    }

    const channelId = parsed.data.data.channelId;
    if (channelId === undefined) return; // nothing to stop
    // Cancel the pending auto-expiry; we're emitting the `stop` explicitly now.
    clearTypingTimer(state, channelId);
    hub.publishToChannel(channelId, typingEvent(channelId, actor, "stop"));
  }

  /**
   * §7.5 presence.subscribe: register this connection as a subscriber of each
   * named user's presence (connection-scoped, like channel subscriptions), ack
   * with `presence.subscribed`, then IMMEDIATELY send an initial `presence.update`
   * snapshot for each subscribed user — filtered for THIS viewer exactly as
   * `GET /api/users/{ref}/presence` would be (so the two surfaces agree). Subjects
   * are subscribed by canonical actor; a snapshot for a non-local subject simply
   * reflects whatever state we hold (none → effectively offline).
   */
  function handlePresenceSubscribe(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsPresenceSubscribeSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed presence.subscribe command", 400, frameId));
      return;
    }
    const hubConn = state.hubConn;
    if (!hubConn) return; // unreachable: only authenticated connections reach here

    // Normalize each subject to its canonical actor key so the registry key
    // matches the fan-out key (`${handle}@${host}`); the snapshot `user` field
    // uses the same canonical actor the fan-out emits, keeping them consistent.
    const subjects = parsed.data.data.users.map((u) => `${subjectHandleOf(u)}@${authority}`);
    presenceRegistry.subscribe(hubConn, subjects);

    // Ack first, then the per-user snapshot (§7.5).
    send(ws, {
      type: "presence.subscribed",
      correlationId: frameId,
      data: WsPresenceSubscribedSchema.shape.data.parse({ users: subjects }),
    });

    const viewer = {
      actor: state.actor as string,
      handle: state.handle as string,
      domain: authority,
    };
    for (const subject of subjects) {
      const eff = filterPresenceFor(db, hub, config, subjectHandleOf(subject), viewer);
      send(ws, presenceUpdateEvent(subject, toPresence(eff)));
    }
  }

  /**
   * §7.5 presence.unsubscribe: drop this connection's subscription to each named
   * user's presence and ack `presence.unsubscribed`. No further updates flow for
   * those subjects until re-subscribed.
   */
  function handlePresenceUnsubscribe(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsPresenceUnsubscribeSchema.safeParse(rawFrame);
    if (!parsed.success) {
      send(ws, errorEvent("bad_request", "malformed presence.unsubscribe command", 400, frameId));
      return;
    }
    const hubConn = state.hubConn;
    if (!hubConn) return;

    // Normalize to the same canonical actor key used at subscribe time.
    const subjects = parsed.data.data.users.map((u) => `${subjectHandleOf(u)}@${authority}`);
    presenceRegistry.unsubscribe(hubConn, subjects);
    send(ws, {
      type: "presence.unsubscribed",
      correlationId: frameId,
      data: WsPresenceUnsubscribedSchema.shape.data.parse({ users: subjects }),
    });
  }

  /**
   * §7.5 presence.set: equivalent to `PUT /api/me/presence` — update the caller's
   * stored EXPLICIT availability/status (the schema already rejects `offline` as a
   * set value) and fan out a privacy-filtered `presence.update` to subscribers.
   * The same stored value drives both surfaces (§7.5 reconciliation).
   */
  function handlePresenceSet(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
    const parsed = WsPresenceSetSchema.safeParse(rawFrame);
    if (!parsed.success) {
      // A malformed frame OR an `offline` availability (not in the set enum) lands
      // here — both are rejected (§7.5: `offline` is not settable).
      send(ws, errorEvent("bad_request", "malformed presence.set command", 400, frameId));
      return;
    }
    const handle = state.handle;
    if (!handle) return; // unreachable: only authenticated connections reach here

    const { availability, status } = parsed.data.data;
    setExplicitPresence(db, handle, availability, status ?? undefined);
    fanOutPresence(db, hub, config, presenceRegistry, handle);
  }
}

/**
 * Resolve a canonical subject actor (`handle@domain`) to its local handle. A
 * bare handle (no `@`) is treated as local; the local/remote split only matters
 * for the visibility resolver, which keys on the handle.
 */
function subjectHandleOf(subject: string): string {
  const at = subject.lastIndexOf("@");
  return at > 0 ? subject.slice(0, at) : subject;
}

/** Validates the optional `attachments` array on a `message.create` command. */
const AttachmentsSchema = z.array(AttachmentSchema);

/**
 * Build a validated `message.created` event for `record`, with the message's
 * opaque `cursor` on `data` (§7.1 resume / §7.2 history share one cursor space).
 * When `correlationId` is given it is echoed (the author's own copy correlates to
 * the request per the §7.1 example); resume replays pass `undefined` since a
 * replayed event is not a response to any client frame. The fan-out payload is
 * re-validated against the shared `WsMessageCreated` schema before the wire.
 */
function createdEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId?: string,
): OutboundEvent {
  const message = record.message satisfies Message;
  const data = WsMessageCreatedSchema.shape.data.parse({
    groupId,
    channelId,
    cursor: record.cursor,
    message,
  });
  return {
    type: "message.created",
    ...(correlationId !== undefined ? { correlationId } : {}),
    data,
  };
}

/**
 * Build a validated `message.updated` event for an edited `record` (§7.1). Mirrors
 * {@link createdEvent}: the editor's own copy correlates to the request id, the
 * event carries the message's resume `cursor` (so clients can advance their
 * resume position off edits), and the payload is re-validated against the shared
 * `WsMessageUpdated` schema.
 */
function updatedEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId: string,
): OutboundEvent {
  const message = record.message satisfies Message;
  const data = WsMessageUpdatedSchema.shape.data.parse({
    groupId,
    channelId,
    cursor: record.cursor,
    message,
  });
  return { type: "message.updated", correlationId, data };
}

/** Whether `err` is a SQLite UNIQUE-constraint violation (idempotency race). */
function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}
