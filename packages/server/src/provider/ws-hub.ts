/**
 * WebSocket connection hub (spec §7.1) — the real-time fan-out backbone.
 *
 * This is the single in-memory registry of live, **authenticated** WS
 * connections and their subscriptions. Every later real-time feature
 * (message fan-out, reactions, typing, presence, DM, calls) publishes through
 * this hub rather than reaching into sockets directly, so the routing logic
 * lives in exactly one place.
 *
 * ## Model
 *  - A {@link HubConnection} is one authenticated socket plus its mutable
 *    subscription set (channel ids) and identity (`actor`).
 *  - Two reverse indexes keep fan-out O(subscribers):
 *      - `channelId → Set<connection>` for channel events (`publishToChannel`);
 *      - `actor     → Set<connection>` for per-actor events (DM/presence later,
 *        `publishToActor`). One actor MAY have several connections (devices).
 *  - The WS handler calls {@link add} once a connection authenticates, mutates
 *    its subscriptions via {@link subscribe}/{@link unsubscribe}, and calls
 *    {@link remove} on close (which cleans up every index entry).
 *
 * ## Sending
 * {@link send} is the one place that stamps the envelope `ts` (RFC 3339) and
 * serializes to JSON, so publishers pass a partial event (`type`/`data`/…) and
 * never worry about wire framing. Publishers only fan out — they do NOT
 * re-check authorization; that was enforced at subscribe-time (§7.1).
 *
 * The hub is transport-only: it holds no DB handle and makes no authz
 * decisions. It is created once in `app.ts` and handed to the WS handler (and,
 * later, to message/reaction/etc. handlers via the app context).
 */
import { rfc3339Timestamp } from "@forumall/shared";

/**
 * The minimal socket surface the hub needs. Bun's `ServerWebSocket` and the
 * browser `WebSocket` both satisfy this; keeping it structural means the hub
 * has no hard dependency on Bun's types and is trivially fake-able in tests.
 */
export interface HubSocket {
  send(data: string): unknown;
}

/**
 * An outbound event to publish. `id`/`ts` are filled in by {@link Hub.send} if
 * omitted, so callers normally pass just `type` + `data` (+ optional
 * `correlationId`). Any extra envelope fields are preserved.
 */
export interface OutboundEvent {
  /** Frame id, unique within a connection. Auto-generated (`evt_…`) if omitted. */
  id?: string;
  /** Event type string (e.g. `message.created`). */
  type: string;
  /** RFC 3339 timestamp. Stamped by {@link Hub.send} if omitted. */
  ts?: string;
  /** Echoes the originating client frame `id` for request/response events. */
  correlationId?: string;
  /** Event payload. */
  data?: unknown;
}

/** `evt_` id prefix for server-originated frames (§7.1 examples). */
const EVENT_ID_PREFIX = "evt_";

/** Mint a connection-unique server event id. */
function mintEventId(): string {
  return `${EVENT_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * One authenticated connection registered in the hub. The WS handler owns the
 * lifecycle; the hub owns the indexes. `subscriptions` is the source of truth
 * for what this connection receives and is kept in sync with the reverse index.
 */
export interface HubConnection {
  /** The live socket to write events to. */
  readonly socket: HubSocket;
  /** Authenticated actor (`handle@domain`) this connection belongs to. */
  readonly actor: string;
  /** Channel ids this connection is currently subscribed to. */
  readonly subscriptions: Set<string>;
}

/**
 * In-memory hub of live authenticated connections + their subscriptions.
 *
 * Single-node only: a multi-node deployment would publish via a shared bus
 * (e.g. Redis pub/sub) behind this same API. Later cards depend on the public
 * surface (`add`/`remove`/`subscribe`/`unsubscribe`/`publishToChannel`/
 * `publishToActor`/`send`), so keep it stable.
 */
export class Hub {
  /** All registered connections (for diagnostics / counts). */
  private readonly connections = new Set<HubConnection>();
  /** Reverse index: channel id → connections subscribed to it. */
  private readonly byChannel = new Map<string, Set<HubConnection>>();
  /** Reverse index: actor → that actor's connections (multiple devices). */
  private readonly byActor = new Map<string, Set<HubConnection>>();

  /**
   * Register an authenticated connection. Call once, right after `authenticate`
   * succeeds. The connection starts with no channel subscriptions.
   */
  add(conn: HubConnection): void {
    this.connections.add(conn);
    addTo(this.byActor, conn.actor, conn);
    // Re-index any channels it is already subscribed to (normally none yet).
    for (const channelId of conn.subscriptions) {
      addTo(this.byChannel, channelId, conn);
    }
  }

  /**
   * Remove a connection and purge it from every index. Idempotent — safe to
   * call on any close, even for a connection that never authenticated/was added.
   */
  remove(conn: HubConnection): void {
    this.connections.delete(conn);
    removeFrom(this.byActor, conn.actor, conn);
    for (const channelId of conn.subscriptions) {
      removeFrom(this.byChannel, channelId, conn);
    }
    conn.subscriptions.clear();
  }

  /**
   * Add `channelIds` to a connection's subscription set and the channel index.
   * Authorization is the caller's responsibility (enforced at subscribe-time in
   * the WS handler). Idempotent per channel.
   */
  subscribe(conn: HubConnection, channelIds: readonly string[]): void {
    for (const channelId of channelIds) {
      if (!conn.subscriptions.has(channelId)) {
        conn.subscriptions.add(channelId);
        addTo(this.byChannel, channelId, conn);
      }
    }
  }

  /** Remove `channelIds` from a connection's subscriptions + the channel index. */
  unsubscribe(conn: HubConnection, channelIds: readonly string[]): void {
    for (const channelId of channelIds) {
      if (conn.subscriptions.delete(channelId)) {
        removeFrom(this.byChannel, channelId, conn);
      }
    }
  }

  /**
   * Fan out `event` to every connection subscribed to `channelId`. No-op if the
   * channel has no subscribers. Used by message/reaction/typing/call cards.
   */
  publishToChannel(channelId: string, event: OutboundEvent): void {
    const subs = this.byChannel.get(channelId);
    if (!subs) return;
    const frame = this.frame(event);
    for (const conn of subs) this.write(conn.socket, frame);
  }

  /**
   * Fan out `event` to every connection of `actor` (across devices). Used by the
   * DM/presence cards later. No-op if the actor has no live connections.
   */
  publishToActor(actor: string, event: OutboundEvent): void {
    const conns = this.byActor.get(actor);
    if (!conns) return;
    const frame = this.frame(event);
    for (const conn of conns) this.write(conn.socket, frame);
  }

  /**
   * Send a single `event` to one connection's socket, stamping `id`/`ts` and
   * serializing. The low-level write helper every command handler uses to reply
   * (acks, errors, pong). Safe against a socket that has already closed.
   */
  send(socket: HubSocket, event: OutboundEvent): void {
    this.write(socket, this.frame(event));
  }

  /** Number of currently-registered connections (diagnostics / tests). */
  get size(): number {
    return this.connections.size;
  }

  /** Connections currently subscribed to `channelId` (diagnostics / tests). */
  subscriberCount(channelId: string): number {
    return this.byChannel.get(channelId)?.size ?? 0;
  }

  /** Build the serialized wire frame for an event, filling `id`/`ts`. */
  private frame(event: OutboundEvent): string {
    const envelope: Record<string, unknown> = {
      id: event.id ?? mintEventId(),
      type: event.type,
      ts: event.ts ?? rfc3339Timestamp(),
      ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
      ...(event.data !== undefined ? { data: event.data } : {}),
    };
    return JSON.stringify(envelope);
  }

  /** Write a pre-serialized frame, swallowing errors from a dead socket. */
  private write(socket: HubSocket, frame: string): void {
    try {
      socket.send(frame);
    } catch {
      // The socket may have closed between selection and write; a later card's
      // close handler will `remove()` it. Dropping the frame is correct here.
    }
  }
}

/** Add `value` to the set at `key`, creating the set if needed. */
function addTo<V>(index: Map<string, Set<V>>, key: string, value: V): void {
  let set = index.get(key);
  if (!set) {
    set = new Set<V>();
    index.set(key, set);
  }
  set.add(value);
}

/** Remove `value` from the set at `key`, dropping the set when it empties. */
function removeFrom<V>(index: Map<string, Set<V>>, key: string, value: V): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) index.delete(key);
}
