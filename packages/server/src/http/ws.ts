/**
 * WebSocket transport (spec §7.1) — the signed-challenge handshake, subscribe /
 * unsubscribe authorization, heartbeat, and the wiring into the connection
 * {@link Hub}. This is the real-time backbone; message posting / fan-out,
 * reactions, typing, presence, DM, calls and resume (`since`) are LATER cards
 * that build on the hub exposed here.
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
 *     over the challenge nonce we issued (timestamp skew ±300s, local key
 *     resolution; remote actors are P7 and fail closed). On success →
 *     `authenticated { actor }` + register in the hub. On failure → an `error`
 *     event then close code 4001.
 *
 * After auth, unknown command types are ignored (open-world, §2.3); malformed
 * frames get an `error` event.
 */
import {
  AttachmentSchema,
  type Message,
  MessageReferenceSchema,
  WsAuthenticateSchema,
  WsEnvelopeSchema,
  WsMessageCreateSchema,
  WsMessageCreatedSchema,
  WsMessageDeleteSchema,
  WsMessageDeletedSchema,
  WsMessageUpdateSchema,
  WsMessageUpdatedSchema,
  WsSubscribeSchema,
  WsUnsubscribeSchema,
  canonicalAuthority,
  isKnownWsType,
  rfc3339Timestamp,
  verifyWsAuthenticate,
} from "@forumall/shared";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { channelVisibleTo, getChannelRow } from "../provider/channels.ts";
import { resolveActorKeys } from "../provider/device-keys.ts";
import {
  type MessageRecord,
  createMessage,
  getMessageByClientId,
  tombstoneMessage,
  updateMessageContent,
} from "../provider/messages.ts";
import { canActor } from "../provider/permissions.ts";
import type { Hub, HubConnection, HubSocket, OutboundEvent } from "../provider/ws-hub.ts";
import { authorizeMessageDelete, authorizeMessageEdit } from "./message-mutations.ts";

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
  /** Heartbeat/handshake timings; defaults to {@link DEFAULT_WS_TIMINGS}. */
  readonly timings?: Partial<WsTimings>;
}

/**
 * Build the Hono WS route handlers (`open`/`message`/`close`) for `upgradeWebSocket`.
 * Returned as a factory so `upgradeWebSocket(() => handlers)` can pass it
 * straight to the route, while the closure captures `deps` + per-socket state.
 */
export function createWsHandlers(deps: WsHandlerDeps) {
  const { config, db, hub } = deps;
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

  /** Tear down timers + hub registration for a connection. Idempotent. */
  function teardown(state: ConnState | undefined): void {
    if (!state) return;
    if (state.authTimer) clearTimeout(state.authTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.hubConn) hub.remove(state.hubConn);
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
        handleAuthenticate(ws, state, raw_json, envelope.id);
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

  /** §7.1 Authentication: verify the signed challenge and register the connection. */
  function handleAuthenticate(
    ws: WsContext,
    state: ConnState,
    rawFrame: unknown,
    frameId: string,
  ): void {
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

    // Resolve the actor's verification key (§4.5 step 6). Local actors only;
    // a non-local actor domain is P7 (remote key resolution via the §4.6 keys
    // endpoint) and fails closed here, exactly like the HTTP signature path.
    const at = actor.lastIndexOf("@");
    if (at <= 0 || at === actor.length - 1) {
      fail("malformed actor");
      return;
    }
    const handle = actor.slice(0, at);
    const actorDomain = canonicalAuthority(actor.slice(at + 1));
    if (actorDomain !== authority) {
      // P7: fetch the remote actor's keys (§4.6) and verify; fail closed now.
      fail("remote actor resolution is not yet supported");
      return;
    }
    const key = resolveActorKeys(db, handle).find((k) => k.keyId === keyId);
    if (!key) {
      fail("no active device key matches actor/keyId");
      return;
    }

    // §7.1 step 3 (crypto): verify the signature over OUR challenge nonce.
    const ok = verifyWsAuthenticate({
      publicKey: key.publicKey,
      authority,
      challengeNonce: state.challengeNonce,
      timestamp,
      signature,
    });
    if (!ok) {
      fail("invalid authenticate signature");
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
    hub.add(hubConn);

    send(ws, { type: "authenticated", correlationId: frameId, data: { actor } });
  }

  /**
   * §7.1 Subscriptions: enforce per-channel visibility (membership + tier) at
   * subscribe-time, ack the authorized ones, and reject unauthorized channels
   * with a `forbidden` error. `since`/`include` are accepted but `since` replay
   * is a LATER card (resume), so it is no-op'd here.
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

    const authorized: string[] = [];
    const forbidden: string[] = [];
    for (const channelId of parsed.data.data.channels) {
      const row = getChannelRow(db, channelId);
      // Unknown channel or actor not permitted by tier/membership → forbidden.
      if (row && channelVisibleTo(db, row.groupId, row.tier, state.actor)) {
        authorized.push(channelId);
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
    if (authorized.length > 0) {
      hub.subscribe(hubConn, authorized);
      send(ws, { type: "subscribed", correlationId: frameId, data: { channels: authorized } });
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
    // `attachments` / `reference` are open-world passthrough on the command
    // schema; validate them here against the canonical shapes (drop if invalid).
    const extra = parsed.data.data as Record<string, unknown>;
    const attachments = AttachmentsSchema.safeParse(extra.attachments);
    const reference = MessageReferenceSchema.safeParse(extra.reference);

    // --- Authorization -----------------------------------------------------
    // The channel must exist, belong to the named group, be visible to the
    // actor, AND the actor must hold the group's `post` permission. Any failure
    // → forbidden (don't leak existence beyond what subscribe already does).
    const channel = getChannelRow(db, channelId);
    const authorized =
      channel != null &&
      channel.groupId === groupId &&
      channelVisibleTo(db, channel.groupId, channel.tier, author) &&
      canActor(db, "post", groupId, author);
    if (!authorized) {
      send(ws, errorEvent("forbidden", "not authorized to post to this channel", 403, frameId));
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
        type: "message",
        content,
        ...(attachments.success ? { attachments: attachments.data } : {}),
        ...(reference.success ? { reference: reference.data } : {}),
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
      data: WsMessageDeletedSchema.shape.data.parse({ groupId, channelId, messageId, deletedAt }),
    });
  }
}

/** Validates the optional `attachments` array on a `message.create` command. */
const AttachmentsSchema = z.array(AttachmentSchema);

/**
 * Build a validated `message.created` event for `record`, with the message's
 * opaque `cursor` on `data` (§7.1 resume / §7.2 history share one cursor space)
 * and the request `correlationId` echoed (the author's copy correlates to the
 * request per the §7.1 example). The fan-out payload is re-validated against the
 * shared `WsMessageCreated` schema before it goes on the wire.
 */
function createdEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId: string,
): OutboundEvent {
  const message = record.message satisfies Message;
  const data = WsMessageCreatedSchema.shape.data.parse({
    groupId,
    channelId,
    cursor: record.cursor,
    message,
  });
  return { type: "message.created", correlationId, data };
}

/**
 * Build a validated `message.updated` event for an edited `record` (§7.1). Mirrors
 * {@link createdEvent}: the editor's own copy correlates to the request id and the
 * payload is re-validated against the shared `WsMessageUpdated` schema.
 */
function updatedEvent(
  groupId: string,
  channelId: string,
  record: MessageRecord,
  correlationId: string,
): OutboundEvent {
  const message = record.message satisfies Message;
  const data = WsMessageUpdatedSchema.shape.data.parse({ groupId, channelId, message });
  return { type: "message.updated", correlationId, data };
}

/** Whether `err` is a SQLite UNIQUE-constraint violation (idempotency race). */
function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}
