/**
 * `OfscpWsClient` command delivery around the §7.1 handshake, driven frame by
 * frame through a scripted socket (helpers/fake-ws.ts):
 *
 *  - no command is written before `authenticated` (the provider would close the
 *    connection with `4001`); commands wait in order and go out after the
 *    resume `subscribe`, ahead of anything a `connected` listener sends,
 *  - typing-style commands are dropped, not queued, while disconnected,
 *  - an idempotent command the connection dropped before answering is re-sent,
 *    under the same id, on the next connection; an answered one is not,
 *  - waiting commands are reported undelivered when the client closes for good,
 *    and a command sent on a closed client only after `send` has returned,
 *  - a drop reconnects with backoff, re-authenticates, and re-subscribes with
 *    the `since` cursor of the last timeline event — which a cursor-less
 *    duplicate-create answer never moves.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPair } from "@forumall/shared";
import { OfscpWsClient } from "../src/lib/ofscp-ws.ts";
import { FakeWebSocket, until } from "./helpers/fake-ws.ts";

const { privateKey } = generateKeyPair();
const clients: OfscpWsClient[] = [];

function makeClient(opts: { autoReconnect?: boolean } = {}): OfscpWsClient {
  const client = new OfscpWsClient({
    host: "providera.test",
    actor: "alice@providera.test",
    keyId: "key_1",
    privateKey,
    url: "ws://fake/api/ws",
    // The test double stands in for the DOM WebSocket constructor.
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    autoReconnect: opts.autoReconnect ?? true,
    backoff: { initial: 1, max: 1 },
  });
  clients.push(client);
  return client;
}

beforeEach(() => FakeWebSocket.reset());
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

describe("commands wait for `authenticated` (§7.1)", () => {
  test("a command sent while connecting / authenticating is held, then sent after subscribe", async () => {
    const client = makeClient();
    client.subscribe(["chn_1"]);
    const connected = client.connect();
    const sock = FakeWebSocket.latest();

    const first = client.send("message.create", { channelId: "chn_1", n: 1 });
    sock.open();
    const second = client.send("reaction.add", { channelId: "chn_1", n: 2 });
    sock.challenge();
    // Mid-handshake: only `authenticate` has been written.
    expect(sock.sentTypes()).toEqual(["authenticate"]);
    expect(client.state).toBe("authenticating");

    sock.authenticated();
    await connected;
    expect(sock.sentTypes()).toEqual([
      "authenticate",
      "subscribe",
      "message.create",
      "reaction.add",
    ]);
    expect(sock.sent[2]?.id).toBe(first);
    expect(sock.sent[3]?.id).toBe(second);
    expect(sock.sent[2]?.data).toEqual({ channelId: "chn_1", n: 1 });
  });

  test("a `connected` listener's send goes out after the resume subscribe and the queued commands", async () => {
    const client = makeClient();
    client.subscribe(["chn_1"]);
    const queued = client.send("message.create", { channelId: "chn_1" });
    const fromListener: string[] = [];
    client.onState((s) => {
      if (s === "connected")
        fromListener.push(client.send("presence.subscribe", { users: ["b@x"] }));
    });
    const connected = client.connect();
    const sock = FakeWebSocket.latest();
    sock.handshake();
    await connected;
    expect(sock.sentTypes()).toEqual([
      "authenticate",
      "subscribe",
      "message.create",
      "presence.subscribe",
    ]);
    expect(sock.sent[2]?.id).toBe(queued);
    expect(sock.sent[3]?.id).toBe(fromListener[0]);
  });

  test("once connected, a command is written at once", async () => {
    const client = makeClient();
    const connected = client.connect();
    const sock = FakeWebSocket.latest();
    sock.handshake();
    await connected;
    const id = client.send("message.delete", { messageId: "msg_1" });
    expect(sock.sent.at(-1)).toMatchObject({ id, type: "message.delete" });
  });

  test("a `drop` command is discarded (and reported) while not authenticated", async () => {
    const client = makeClient();
    const connected = client.connect();
    const sock = FakeWebSocket.latest();
    let undelivered = 0;
    sock.open();
    client.send(
      "typing.start",
      { channelId: "chn_1" },
      {
        whenDisconnected: "drop",
        onUndelivered: () => {
          undelivered += 1;
        },
      },
    );
    sock.challenge();
    sock.authenticated();
    await connected;
    expect(undelivered).toBe(1);
    expect(sock.sentTypes()).toEqual(["authenticate"]);
  });

  test("a client ping before `authenticated` is not sent", () => {
    const client = makeClient();
    void client.connect().catch(() => undefined);
    const sock = FakeWebSocket.latest();
    sock.open();
    client.ping();
    expect(sock.sent).toEqual([]);
  });
});

describe("failure on disconnect", () => {
  test("waiting commands are reported undelivered on close(); later sends just after send returns", async () => {
    const client = makeClient();
    void client.connect().catch(() => undefined);
    const failed: string[] = [];
    client.send("message.create", { n: 1 }, { onUndelivered: () => failed.push("a") });
    client.send("message.update", { n: 2 }, { onUndelivered: () => failed.push("b") });
    client.close();
    expect(failed).toEqual(["a", "b"]);
    // The callback may use the id `send` returns, so it never runs inside `send`
    // (reading `returnedId` there would throw: it is not yet initialised).
    let idSeenByCallback: string | undefined;
    const returnedId = client.send(
      "message.create",
      { n: 3 },
      {
        onUndelivered: () => {
          idSeenByCallback = returnedId;
          failed.push("c");
        },
      },
    );
    expect(failed).toEqual(["a", "b"]);
    await Promise.resolve();
    expect(failed).toEqual(["a", "b", "c"]);
    expect(idSeenByCallback).toBe(returnedId);
  });

  test("close 4003 (credentials revoked) reports waiting commands undelivered", async () => {
    const client = makeClient();
    const connected = client.connect();
    const sock = FakeWebSocket.latest();
    sock.handshake();
    await connected;
    // Written and unanswered (idempotent), so it would be re-sent on a reconnect.
    let failed = 0;
    client.send(
      "message.create",
      { n: 1 },
      {
        idempotent: true,
        onUndelivered: () => {
          failed += 1;
        },
      },
    );
    sock.drop(4003);
    expect(client.state).toBe("closed");
    expect(failed).toBe(1);
  });

  test("commands keep waiting across a failed reconnect attempt", async () => {
    const client = makeClient();
    const connected = client.connect();
    FakeWebSocket.latest().handshake();
    await connected;
    FakeWebSocket.latest().drop();
    expect(client.state).toBe("reconnecting");
    const id = client.send("message.update", { n: 1 });

    // The first attempt dies during the handshake…
    await until(() => FakeWebSocket.instances.length === 2);
    const attempt = FakeWebSocket.latest();
    attempt.open();
    attempt.drop(4001);
    // …the next one completes and delivers the command.
    await until(() => FakeWebSocket.instances.length === 3);
    const sock = FakeWebSocket.latest();
    sock.handshake();
    await until(() => client.state === "connected");
    expect(attempt.sentTypes()).toEqual([]);
    expect(sock.sent.at(-1)).toMatchObject({ id, type: "message.update" });
  });
});

describe("idempotent commands across a drop", () => {
  test("a create the connection dropped before answering is re-sent under the same id", async () => {
    const client = makeClient();
    client.subscribe(["chn_1"]);
    const connected = client.connect();
    const first = FakeWebSocket.latest();
    first.handshake();
    await connected;

    const answered = client.send("message.create", { n: 1 }, { idempotent: true });
    const lost = client.send("message.create", { n: 2 }, { idempotent: true });
    const update = client.send("message.update", { n: 3 });
    // Only the first create is answered (correlated) before the drop.
    first.serverSend({
      id: "evt_1",
      type: "message.created",
      correlationId: answered,
      data: { channelId: "chn_1", cursor: "cur_1", message: {} },
    });
    first.drop();

    await until(() => FakeWebSocket.instances.length === 2);
    const second = FakeWebSocket.latest();
    second.handshake();
    await until(() => client.state === "connected");
    // Re-subscribed (resuming after the answered create), then only the
    // unanswered idempotent create; the non-idempotent update is not re-sent.
    expect(second.sentTypes()).toEqual(["authenticate", "subscribe", "message.create"]);
    expect(second.sent[1]?.data).toEqual({ channels: ["chn_1"], since: { chn_1: "cur_1" } });
    expect(second.sent[2]?.id).toBe(lost);
    expect(second.sent[2]?.data).toEqual({ n: 2 });
    expect(update).not.toBe(lost);
  });

  test("an `error` answering an idempotent command also stops its re-send", async () => {
    const client = makeClient();
    const connected = client.connect();
    const first = FakeWebSocket.latest();
    first.handshake();
    await connected;
    const id = client.send("message.create", { n: 1 }, { idempotent: true });
    first.serverSend({
      id: "evt_e",
      type: "error",
      correlationId: id,
      data: { code: "forbidden", status: 403, message: "no" },
    });
    first.drop();
    await until(() => FakeWebSocket.instances.length === 2);
    const second = FakeWebSocket.latest();
    second.handshake();
    await until(() => client.state === "connected");
    expect(second.sentTypes()).toEqual(["authenticate"]);
  });
});

describe("reconnect and resume (§7.1, federation latency + retries)", () => {
  test("a drop reconnects with backoff, re-authenticates and re-subscribes with `since`", async () => {
    const client = makeClient();
    const states: string[] = [];
    client.onState((s) => states.push(s));
    client.subscribe(["chn_1", "chn_2"]);
    const connected = client.connect();
    const first = FakeWebSocket.latest();
    first.handshake();
    await connected;
    expect(first.sent[1]).toMatchObject({
      type: "subscribe",
      data: { channels: ["chn_1", "chn_2"] },
    });

    first.serverSend({
      id: "evt_1",
      type: "message.created",
      data: { channelId: "chn_1", cursor: "cur_7", message: {} },
    });
    // A duplicate-create answer carries no cursor and is never a resume point.
    first.serverSend({
      id: "evt_2",
      type: "message.created",
      correlationId: "cli_x",
      data: { channelId: "chn_1", message: {} },
    });
    expect(client.cursorFor("chn_1")).toBe("cur_7");

    first.drop();
    expect(client.state).toBe("reconnecting");
    await until(() => FakeWebSocket.instances.length === 2);
    const second = FakeWebSocket.latest();
    second.open();
    second.challenge("nonce-2");
    expect(second.sentTypes()).toEqual(["authenticate"]);
    expect(second.sent[0]?.data).toMatchObject({ actor: "alice@providera.test", keyId: "key_1" });
    second.authenticated();
    await until(() => client.state === "connected");
    expect(second.sent[1]).toMatchObject({
      type: "subscribe",
      data: { channels: ["chn_1", "chn_2"], since: { chn_1: "cur_7" } },
    });
    expect(states).toEqual([
      "connecting",
      "authenticating",
      "connected",
      "reconnecting",
      "authenticating",
      "connected",
    ]);
  });

  test("a cursor-less event leaves `cursorFor` unset when no cursor was seen", async () => {
    const client = makeClient();
    client.subscribe(["chn_1"]);
    const connected = client.connect();
    const sock = FakeWebSocket.latest();
    sock.handshake();
    await connected;
    sock.serverSend({
      id: "evt_d",
      type: "message.created",
      correlationId: "cli_1",
      data: { channelId: "chn_1", message: {} },
    });
    expect(client.cursorFor("chn_1")).toBeUndefined();
  });
});
