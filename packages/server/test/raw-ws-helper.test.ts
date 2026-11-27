/**
 * The raw WebSocket test helper (`helpers/raw-ws.ts`) fails fast instead of
 * hanging: `open()` rejects when the socket ends before the response head, and
 * a frame that is not a valid envelope, or a socket that ends after the head,
 * fails the waiting `ofType` at once. Driven against tiny `Bun.listen` peers
 * that misbehave on purpose.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { RawWsClient } from "./helpers/raw-ws.ts";

type Peer = Bun.TCPSocketListener<undefined>;
let peer: Peer | undefined;
afterEach(() => {
  peer?.stop(true);
  peer = undefined;
});

/** A TCP peer that runs `onRequest` once the upgrade request arrives. */
function listen(onRequest: (sock: Bun.Socket<undefined>) => void): Peer {
  peer = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: (sock) => onRequest(sock) },
  });
  return peer;
}

/** An unmasked server text frame (payload < 126 bytes). */
function textFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  return new Uint8Array([0x81, payload.length, ...payload]);
}

const SWITCHING =
  "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";

describe("raw WS helper fails fast", () => {
  test("open() rejects when the socket closes before the response head", async () => {
    const p = listen((sock) => sock.end());
    const started = Date.now();
    await expect(RawWsClient.open("127.0.0.1", p.port, "/api/ws", {})).rejects.toThrow(
      "before the response head",
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("an invalid frame fails the waiting ofType with the frame in the message", async () => {
    let send: (() => void) | undefined;
    const p = listen((sock) => {
      sock.write(SWITCHING);
      send = () => sock.write(textFrame('{"no":"type"}'));
    });
    const ws = await RawWsClient.open("127.0.0.1", p.port, "/api/ws", {});
    try {
      const waiting = ws.ofType("authenticated", 5000);
      const started = Date.now();
      send?.();
      await expect(waiting).rejects.toThrow('not a valid envelope: {"no":"type"}');
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      ws.close();
    }
  });

  test("a socket closed after the head fails ofType instead of timing out", async () => {
    let end: (() => void) | undefined;
    const p = listen((sock) => {
      sock.write(SWITCHING);
      end = () => sock.end();
    });
    const ws = await RawWsClient.open("127.0.0.1", p.port, "/api/ws", {});
    const waiting = ws.ofType("authenticated", 5000);
    const started = Date.now();
    end?.();
    await expect(waiting).rejects.toThrow("socket closed");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
