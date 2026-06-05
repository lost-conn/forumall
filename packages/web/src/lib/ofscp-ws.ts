/**
 * OFSCP WebSocket client (spec §7.1).
 *
 * One instance per provider host (home + each foreign provider the federation /
 * home-feed cards open). It:
 *
 *  - connects to `wss://{host}/api/ws` (ws:// for an insecure base),
 *  - completes the signed-challenge handshake: receive `auth.challenge`, sign
 *    the §7.1 canonical string with `signWsAuthenticate` (authority = the
 *    provider host, the challenge nonce, a fresh timestamp), send `authenticate`,
 *    await `authenticated`,
 *  - keeps a subscription registry and (re)issues `subscribe` on connect with
 *    each channel's stored `since` cursor so a reconnect resumes without gaps,
 *  - dispatches inbound events to per-type listeners,
 *  - replies to server `ping` with `pong` (heartbeat), and
 *  - auto-reconnects with exponential backoff, advancing per-channel `since`
 *    cursors from `message.created` / `message.updated` / `message.deleted`
 *    events so resume picks up exactly where it left off.
 *
 * The client is transport-only: it does not know about stores; callers wire
 * `on(type, cb)` to feed the channel/message/presence stores.
 */
import { type WsEnvelope, rfc3339Timestamp, signWsAuthenticate } from "@forumall/shared";

/** Connection lifecycle, surfaced for UI (a connection-status indicator). */
export type WsConnectionState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "closed";

/** Credentials needed to authenticate a connection. */
export interface OfscpWsConfig {
  /** Provider host (signing authority), e.g. `providera.com` or `localhost:8787`. */
  host: string;
  /** Authenticated actor, e.g. `alice@providera.com`. */
  actor: string;
  /** Device key id presented in `authenticate`. */
  keyId: string;
  /** Base64 (or hex / raw) Ed25519 private seed used to sign the handshake. */
  privateKey: string;
  /** Override the ws URL scheme/host (tests pass an ephemeral `ws://…` URL). */
  url?: string;
  /** Injectable WebSocket ctor (defaults to the global). */
  WebSocketImpl?: typeof WebSocket;
  /** Backoff tuning (ms). */
  backoff?: { initial?: number; max?: number; factor?: number };
  /** Disable auto-reconnect (tests). Default true. */
  autoReconnect?: boolean;
}

/** A subscription as the client remembers it (so it survives reconnects). */
interface SubscriptionEntry {
  /** Last cursor seen on this channel; replayed as `since` on (re)subscribe. */
  since?: string;
}

/** A single inbound-event listener; returns nothing. */
type Listener = (event: WsEnvelope) => void;

/** Generate a short client frame id. */
let frameCounter = 0;
function nextFrameId(prefix = "cli"): string {
  frameCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${frameCounter.toString(36)}`;
}

/** Build the `wss://`/`ws://` URL for a host, honoring an explicit override. */
function wsUrlFor(config: OfscpWsConfig): string {
  if (config.url) return config.url;
  // Default to secure unless the host is plainly local.
  const insecure = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(config.host);
  const scheme = insecure ? "ws" : "wss";
  return `${scheme}://${config.host}/api/ws`;
}

export class OfscpWsClient {
  private readonly config: OfscpWsConfig;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly autoReconnect: boolean;
  private readonly backoff: { initial: number; max: number; factor: number };

  private ws: WebSocket | null = null;
  private _state: WsConnectionState = "idle";
  /** Per-channel subscription registry; the source of truth across reconnects. */
  private readonly subscriptions = new Map<string, SubscriptionEntry>();
  /** Per-type event listeners. `"*"` receives every event. */
  private readonly listeners = new Map<string, Set<Listener>>();
  /** State-change listeners (UI status). */
  private readonly stateListeners = new Set<(s: WsConnectionState) => void>();

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  /** Resolves once `authenticated` is received for the CURRENT connection. */
  private authWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(config: OfscpWsConfig) {
    this.config = config;
    this.WebSocketImpl = config.WebSocketImpl ?? globalThis.WebSocket;
    this.autoReconnect = config.autoReconnect ?? true;
    this.backoff = {
      initial: config.backoff?.initial ?? 500,
      max: config.backoff?.max ?? 30_000,
      factor: config.backoff?.factor ?? 2,
    };
  }

  get host(): string {
    return this.config.host;
  }

  get state(): WsConnectionState {
    return this._state;
  }

  private setState(s: WsConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    for (const l of this.stateListeners) l(s);
  }

  /** Subscribe to connection-state changes (for a status indicator). */
  onState(cb: (s: WsConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  // -- Event dispatch ------------------------------------------------------

  /**
   * Register a listener for inbound events of `type` (e.g. `"message.created"`),
   * or `"*"` for every event. Returns an unsubscribe fn.
   */
  on(type: string, cb: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  private dispatch(event: WsEnvelope): void {
    for (const l of this.listeners.get(event.type) ?? []) l(event);
    for (const l of this.listeners.get("*") ?? []) l(event);
  }

  // -- Connection lifecycle -----------------------------------------------

  /**
   * Open the connection and complete the handshake. Resolves once the connection
   * is `authenticated` (and any registered subscriptions have been re-issued).
   * Safe to call once; use {@link close} to tear down.
   */
  connect(): Promise<void> {
    this.intentionalClose = false;
    return this.openOnce();
  }

  private openOnce(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    const url = wsUrlFor(this.config);
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;

    const authPromise = new Promise<void>((resolve, reject) => {
      this.authWaiters.push({ resolve, reject });
    });

    ws.addEventListener("open", () => {
      this.setState("authenticating");
      // The server sends `auth.challenge` first; we reply in onMessage.
    });
    ws.addEventListener("message", (e: MessageEvent) => this.onMessage(e));
    ws.addEventListener("close", () => this.onClose());
    ws.addEventListener("error", () => {
      // Surface as a close; the close handler drives reconnect.
    });

    return authPromise;
  }

  private onMessage(e: MessageEvent): void {
    let frame: WsEnvelope;
    try {
      frame = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)) as WsEnvelope;
    } catch {
      return;
    }

    switch (frame.type) {
      case "auth.challenge":
        this.sendAuthenticate((frame.data as { nonce: string }).nonce);
        return;
      case "authenticated":
        this.onAuthenticated();
        return;
      case "ping":
        // §7.1 heartbeat: reply pong echoing the server ping id.
        this.sendRaw({ id: nextFrameId("pong"), type: "pong", correlationId: frame.id, data: {} });
        return;
      case "pong":
        return;
      default:
        this.advanceCursor(frame);
        this.dispatch(frame);
        return;
    }
  }

  private sendAuthenticate(challengeNonce: string): void {
    const timestamp = rfc3339Timestamp();
    const { signature } = signWsAuthenticate({
      privateKey: this.config.privateKey,
      authority: this.config.host,
      challengeNonce,
      timestamp,
    });
    this.sendRaw({
      id: nextFrameId("auth"),
      type: "authenticate",
      ts: rfc3339Timestamp(),
      data: { actor: this.config.actor, keyId: this.config.keyId, timestamp, signature },
    });
  }

  private onAuthenticated(): void {
    this.reconnectAttempts = 0;
    this.setState("connected");
    // Re-issue every remembered subscription with its resume cursor.
    this.resubscribeAll();
    for (const w of this.authWaiters.splice(0)) w.resolve();
  }

  private onClose(): void {
    this.ws = null;
    // Reject any pending auth waiters for this connection.
    for (const w of this.authWaiters.splice(0)) {
      w.reject(new Error("connection closed before authenticated"));
    }
    if (this.intentionalClose || !this.autoReconnect) {
      this.setState("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = Math.min(
      this.backoff.initial * this.backoff.factor ** this.reconnectAttempts,
      this.backoff.max,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      // Swallow the auth promise rejection on a reconnect attempt that itself
      // fails; the next close reschedules.
      void this.openOnce().catch(() => undefined);
    }, delay);
  }

  /** Close the connection and stop reconnecting. */
  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setState("closed");
  }

  // -- Subscriptions -------------------------------------------------------

  /**
   * Subscribe to `channels`. Remembers them (with any `since` cursor) so a
   * reconnect re-subscribes automatically. If currently connected, issues the
   * `subscribe` frame now. `since` maps channel id → resume cursor.
   */
  subscribe(channels: string[], opts: { since?: Record<string, string> } = {}): void {
    for (const channelId of channels) {
      const entry = this.subscriptions.get(channelId) ?? {};
      const since = opts.since?.[channelId];
      if (since !== undefined) entry.since = since;
      this.subscriptions.set(channelId, entry);
    }
    if (this._state === "connected") this.sendSubscribe(channels);
  }

  /** Unsubscribe from `channels` and forget them. */
  unsubscribe(channels: string[]): void {
    for (const c of channels) this.subscriptions.delete(c);
    if (this._state === "connected" && channels.length > 0) {
      this.sendRaw({
        id: nextFrameId("unsub"),
        type: "unsubscribe",
        ts: rfc3339Timestamp(),
        data: { channels },
      });
    }
  }

  /** Re-issue every remembered subscription (after a (re)connect). */
  private resubscribeAll(): void {
    const channels = [...this.subscriptions.keys()];
    if (channels.length > 0) this.sendSubscribe(channels);
  }

  private sendSubscribe(channels: string[]): void {
    const since: Record<string, string> = {};
    for (const c of channels) {
      const cur = this.subscriptions.get(c)?.since;
      if (cur !== undefined) since[c] = cur;
    }
    this.sendRaw({
      id: nextFrameId("sub"),
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: {
        channels,
        ...(Object.keys(since).length > 0 ? { since } : {}),
      },
    });
  }

  /** Client-initiated ping (the server replies `pong`). */
  ping(): void {
    this.sendRaw({ id: nextFrameId("ping"), type: "ping", ts: rfc3339Timestamp(), data: {} });
  }

  /** The current resume cursor for a channel, if any. */
  cursorFor(channelId: string): string | undefined {
    return this.subscriptions.get(channelId)?.since;
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Advance the stored `since` cursor from any timeline event that carries one,
   * keyed by `channelId`, so a later reconnect resumes from the latest delivered
   * message (§7.1 "Resuming after a disconnect").
   */
  private advanceCursor(frame: WsEnvelope): void {
    const data = frame.data as { channelId?: string; cursor?: string } | undefined;
    if (!data?.channelId || !data.cursor) return;
    const entry = this.subscriptions.get(data.channelId);
    if (entry) entry.since = data.cursor;
  }

  private sendRaw(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(frame));
  }
}

/**
 * Registry of one WS client per provider host (home + foreign). The home-feed /
 * federation cards open a client per host through here and reuse it.
 */
export class OfscpWsRegistry {
  private readonly clients = new Map<string, OfscpWsClient>();

  /** Get (or create) the client for a host, configured with `config`. */
  get(config: OfscpWsConfig): OfscpWsClient {
    let client = this.clients.get(config.host);
    if (!client) {
      client = new OfscpWsClient(config);
      this.clients.set(config.host, client);
    }
    return client;
  }

  /** An already-open client for a host, if any. */
  peek(host: string): OfscpWsClient | undefined {
    return this.clients.get(host);
  }

  /** Close + drop every client (logout / teardown). */
  closeAll(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}
