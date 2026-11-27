/**
 * A scripted in-memory WebSocket for driving `OfscpWsClient` through exact
 * frame sequences (§7.1), where the real server can't hold a connection in a
 * given state (mid-handshake, dropped before a reply) on demand.
 *
 * Each `new FakeWebSocket(url)` registers itself in `FakeWebSocket.instances`.
 * Tests then play the server: `open()` (the socket opens; the client waits for
 * the challenge), `challenge()`, `authenticated()`, `serverSend(frame)`, and
 * `drop(code)` (the server closes). Frames the client wrote are in `sent`,
 * parsed.
 */
import type { WsEnvelope } from "@forumall/shared";

type Handler = (event: unknown) => void;

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  /** Every socket constructed since the last {@link FakeWebSocket.reset}. */
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  /** The most recently constructed socket. */
  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no FakeWebSocket constructed yet");
    return ws;
  }

  readonly OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.CONNECTING;
  /** Frames the client wrote, parsed, in order. */
  readonly sent: Array<WsEnvelope & { id: string }> = [];
  private readonly handlers = new Map<string, Handler[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN)
      throw new Error("send on a socket that is not open");
    this.sent.push(JSON.parse(data) as WsEnvelope & { id: string });
  }

  /** Client-initiated close. */
  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  // -- Server side -----------------------------------------------------------

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  serverSend(frame: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  challenge(nonce = "nonce-1"): void {
    this.serverSend({ id: "evt_chal", type: "auth.challenge", data: { nonce } });
  }

  authenticated(): void {
    this.serverSend({ id: "evt_auth", type: "authenticated", data: {} });
  }

  /** Open, challenge, and accept the client's `authenticate` in one go. */
  handshake(): void {
    this.open();
    this.challenge();
    this.authenticated();
  }

  /** The server closes the connection with `code`. */
  drop(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  /** The types of the frames written so far, in order. */
  sentTypes(): string[] {
    return this.sent.map((f) => f.type);
  }

  private emit(type: string, event: unknown): void {
    for (const h of this.handlers.get(type) ?? []) h(event);
  }
}

/** Wait until `predicate` holds (polling briefly), or fail after `timeoutMs`. */
export async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}
