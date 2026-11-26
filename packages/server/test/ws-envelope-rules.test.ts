/**
 * WebSocket envelope, command and close-code rules after authentication
 * (spec §7.1 *WebSocket message envelope*, *WebSocket message types*, *Close
 * codes*, *Heartbeat & liveness*; §2.3): `ts` optional and ignored on
 * commands, `bad_request` for a missing `id`, malformed `data` or an
 * unsupported standard command, unknown types ignored, and the RFC 6455 close
 * codes for idle (1000), shutdown (1001) and oversized frames (1009).
 *
 * See `helpers/ws-harness.ts` for the real-socket harness.
 */
import { describe, expect, test } from "bun:test";

import type { WsTimings } from "../src/http/ws.ts";
import type { CommandHandler } from "../src/http/ws/connection.ts";
import { decodeFrame, routeCommand } from "../src/http/ws/dispatch.ts";
import {
  FAST_TIMINGS,
  connectAndChallenge,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-ws-envelope-");

/** Boot a provider and connect an authenticated `alice`. */
async function authed(name: string, timings?: Partial<WsTimings>, env?: Record<string, string>) {
  const b = boot(name, timings, env);
  const alice = await registerUserWithKey(b, "alice");
  const client = await connectAuthenticated(b, alice);
  return { b, alice, client };
}

describe("WS heartbeat (§7.1)", () => {
  test("ping (no ts) → pong with correlationId echoing the ping id, and a ts", async () => {
    const { client } = await authed("ping");
    client.send({ id: "cli_ping_42", type: "ping", data: {} });
    const pong = await client.next((f) => f.type === "pong" && f.correlationId === "cli_ping_42");
    expect(typeof pong.ts).toBe("string");
    client.close();
  });

  test("a ping whose data is not an object → bad_request correlated to it", async () => {
    const { client } = await authed("ping-bad-data");
    client.send({ id: "cli_ping_bad", type: "ping", data: null });
    const err = await client.ofType("error");
    expect(err.correlationId).toBe("cli_ping_bad");
    expect(err.data).toMatchObject({ code: "bad_request", status: 400 });
    expect(await client.none((f) => f.type === "pong", 100)).toBe(true);
    client.close();
  });

  test("no traffic within the idle timeout → closed 1000, never 4001", async () => {
    const { client } = await authed("idle", {
      ...FAST_TIMINGS,
      pingIntervalMs: 40,
      idleTimeoutMs: 150,
    });
    // The test client never answers the provider's pings.
    await client.waitClosed();
    expect(client.closeCode).toBe(1000);
  });
});

describe("WS envelope rules (§7.1)", () => {
  test("a command's ts is optional and its value ignored", async () => {
    const { b, alice, client } = await authed("ts-ignored");
    const { channelId } = await makeGroupChannel(b, alice);
    client.send({
      id: "s1",
      type: "subscribe",
      ts: "not a timestamp",
      data: { channels: [channelId] },
    });
    const ack = await client.ofType("subscribed");
    expect(ack.correlationId).toBe("s1");
    client.close();
  });

  test("a command with no id → bad_request with no correlationId; the connection stays open", async () => {
    const { client } = await authed("no-id");
    client.send({ type: "subscribe", data: { channels: ["chn_general"] } });
    const err = await client.ofType("error");
    expect(err.correlationId).toBeUndefined();
    expect(err.data).toMatchObject({ code: "bad_request", status: 400 });
    client.send({ id: "p1", type: "ping", data: {} });
    expect((await client.ofType("pong")).correlationId).toBe("p1");
    client.close();
  });

  test("a frame that is not JSON → bad_request with no correlationId", async () => {
    const { client } = await authed("not-json");
    client.sendText("{not json");
    const err = await client.ofType("error");
    expect(err.correlationId).toBeUndefined();
    expect(err.data).toMatchObject({ code: "bad_request" });
    client.close();
  });

  for (const [label, data] of [
    ["data that does not match its schema", { channels: "chn_general" }],
    ["data that is not an object", null],
  ] as const) {
    test(`a standard command with ${label} → bad_request correlated to it`, async () => {
      const { client } = await authed(`bad-data-${data === null ? "null" : "shape"}`);
      client.send({ id: "cli_bad", type: "subscribe", data });
      const err = await client.ofType("error");
      expect(err.correlationId).toBe("cli_bad");
      expect(err.data).toMatchObject({ code: "bad_request", status: 400 });
      client.close();
    });
  }

  test("an unknown non-standard command type is ignored (§2.3)", async () => {
    const { client } = await authed("unknown-type");
    client.send({ id: "cli_future", type: "some.future.command", data: { x: 1 } });
    // A standard event type sent as a command is not a standard command either.
    client.send({ id: "cli_evt", type: "subscribed", data: {} });
    client.send({ id: "p1", type: "ping", data: {} });
    const next = await client.next();
    expect(next.type).toBe("pong");
    expect(next.correlationId).toBe("p1");
    client.close();
  });
});

describe("WS command routing (§7.1, §2.3)", () => {
  const handler: CommandHandler = () => undefined;

  test("a standard command with a handler is routed to it", () => {
    expect(routeCommand("subscribe", { subscribe: handler })).toEqual({ kind: "handler", handler });
  });

  test("a standard command the provider does not support → unsupported (answered bad_request)", () => {
    expect(routeCommand("message.create", { subscribe: handler })).toEqual({ kind: "unsupported" });
  });

  test("a non-standard type, or a standard EVENT type, is ignored", () => {
    for (const type of ["some.future.command", "subscribed", "toString", "__proto__"]) {
      expect(routeCommand(type, { subscribe: handler })).toEqual({ kind: "ignore" });
    }
  });

  test("decodeFrame keeps only a non-empty string id/type", () => {
    expect(decodeFrame("nope")).toEqual({ kind: "invalid_json" });
    expect(decodeFrame(JSON.stringify({ id: "", type: 3, data: {} }))).toMatchObject({
      kind: "frame",
      id: undefined,
      type: undefined,
    });
    expect(decodeFrame(new TextEncoder().encode('{"id":"a","type":"ping"}').buffer)).toMatchObject({
      id: "a",
      type: "ping",
    });
  });
});

describe("WS close codes (§7.1)", () => {
  test("provider shutdown closes every connection, authenticated or not, with 1001", async () => {
    const { b, client } = await authed("shutdown");
    const { client: pending } = await connectAndChallenge(b);
    b.app.__closeWebSockets();
    await Promise.all([client.waitClosed(), pending.waitClosed()]);
    expect(client.closeCode).toBe(1001);
    expect(pending.closeCode).toBe(1001);
    expect(b.hub.size).toBe(0);
  });

  test("a frame over the provider's size limit closes the connection with 1009", async () => {
    const { client } = await authed("oversized", undefined, { WS_MAX_FRAME_BYTES: "1024" });
    client.send({ id: "big", type: "ping", data: { pad: "x".repeat(4096) } });
    await client.waitClosed();
    expect(client.closeCode).toBe(1009);
  });
});
