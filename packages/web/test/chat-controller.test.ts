/**
 * Chat controller (§7.1) against a scripted socket (helpers/fake-ws.ts) and a
 * stubbed history fetch:
 *
 *  - a send issued during the handshake goes out only after `authenticated`,
 *    carrying the `mentions` its text names (§5.3),
 *  - a correlated, cursor-less duplicate-create `message.created` resolves the
 *    pending send: no new message, and the resume cursor does not move,
 *  - a create the connection dropped before answering is re-sent after the
 *    reconnect, and the provider's duplicate answer settles the echo,
 *  - a send that can never be delivered marks its echo failed (also on a client
 *    that is already closed), and a retry resends the whole message under its
 *    original `clientMessageId`,
 *  - a correlated `error` answering a create (`403`, `400`) marks its echo
 *    failed and settles the send,
 *  - an edit resends `mentions` recomputed from the new text (§5.3, §7.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Attachment, type Message, generateKeyPair } from "@forumall/shared";
import {
  type ChannelHandle,
  editMessage,
  openChannel,
  retrySend,
  sendMessage,
} from "../src/components/chat/chat-controller.ts";
import { OfscpClient } from "../src/lib/ofscp-client.ts";
import { OfscpWsClient } from "../src/lib/ofscp-ws.ts";
import { clearChat, cursorFor, messagesFor } from "../src/stores/chat.ts";
import { FakeWebSocket, until } from "./helpers/fake-ws.ts";

const HOST = "providera.test";
const ME = `alice@${HOST}`;
const GROUP = "grp_1";
const CHANNEL = "chn_1";
const { privateKey } = generateKeyPair();

/** A message cursor in the server's encoding (base64url JSON `{ seq }`). */
function cursorAt(seq: number): string {
  return btoa(JSON.stringify({ seq })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const CUR_5 = cursorAt(5);

/** A signing client whose every request answers with an empty history page. */
function emptyHistoryClient(): OfscpClient {
  const fetchStub = (async () =>
    new Response(JSON.stringify({ items: [], page: { nextCursor: null } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return new OfscpClient({
    baseUrl: `https://${HOST}`,
    actor: ME,
    keyId: "key_1",
    privateKey,
    fetch: fetchStub,
  });
}

const handles: ChannelHandle[] = [];
const wsClients: OfscpWsClient[] = [];

function wsClient(): OfscpWsClient {
  const ws = new OfscpWsClient({
    host: HOST,
    actor: ME,
    keyId: "key_1",
    privateKey,
    url: "ws://fake/api/ws",
    // The test double stands in for the DOM WebSocket constructor.
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    backoff: { initial: 1, max: 1 },
  });
  wsClients.push(ws);
  return ws;
}

/** A connected client with `CHANNEL` open. */
async function openConnected(): Promise<{ ws: OfscpWsClient; sock: FakeWebSocket }> {
  const ws = wsClient();
  const connected = ws.connect();
  const sock = FakeWebSocket.latest();
  sock.handshake();
  await connected;
  handles.push(
    await openChannel({ client: emptyHistoryClient(), ws, groupId: GROUP, channelId: CHANNEL }),
  );
  return { ws, sock };
}

/** The canonical message the provider stores for a create. */
function stored(
  id: string,
  clientMessageId: string,
  text: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    author: ME,
    type: "message",
    content: { mime: "text/plain", text },
    createdAt: "2026-11-27T10:00:00Z",
    clientMessageId,
    ...extra,
  } as Message;
}

/** The last `message.create` frame the client wrote on `sock`. */
function lastCreate(sock: FakeWebSocket) {
  const frame = sock.sent.filter((f) => f.type === "message.create").at(-1);
  if (!frame) throw new Error("no message.create written");
  return frame as typeof frame & { data: Record<string, unknown> & { clientMessageId: string } };
}

beforeEach(() => {
  FakeWebSocket.reset();
  clearChat();
});
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const ws of wsClients.splice(0)) ws.close();
});

describe("sendMessage on the wire", () => {
  test("a send during the handshake is written only after `authenticated`, with `mentions`", async () => {
    const ws = wsClient();
    const connected = ws.connect();
    const sock = FakeWebSocket.latest();
    sock.open();
    sendMessage({
      ws,
      groupId: GROUP,
      channelId: CHANNEL,
      author: ME,
      text: "hi @bob and @carol@other.example, cc @bob",
    });
    sock.challenge();
    expect(sock.sentTypes()).toEqual(["authenticate"]);
    expect(messagesFor(CHANNEL)[0]?.pending).toBe(true);

    sock.authenticated();
    await connected;
    expect(sock.sentTypes()).toEqual(["authenticate", "message.create"]);
    expect(lastCreate(sock).data.mentions).toEqual([`bob@${HOST}`, "carol@other.example"]);
  });

  test("text naming nobody sends no `mentions`", async () => {
    const { ws, sock } = await openConnected();
    sendMessage({ ws, groupId: GROUP, channelId: CHANNEL, author: ME, text: "mail a@b.example" });
    expect("mentions" in lastCreate(sock).data).toBe(false);
  });
});

describe("duplicate-create answers (§7.1)", () => {
  test("a correlated, cursor-less duplicate resolves the pending send without a new message", async () => {
    const { ws, sock } = await openConnected();
    // An earlier message sets the resume cursor.
    sock.serverSend({
      id: "evt_0",
      type: "message.created",
      data: {
        channelId: CHANNEL,
        cursor: CUR_5,
        message: stored("msg_0", "cmid_other", "earlier"),
      },
    });
    expect(cursorFor(CHANNEL)).toBe(CUR_5);

    const cmid = sendMessage({ ws, groupId: GROUP, channelId: CHANNEL, author: ME, text: "hello" });
    const frame = lastCreate(sock);
    // The provider already had this create: it answers with the stored message
    // as it now stands (here, edited), correlated and without a cursor.
    sock.serverSend({
      id: "evt_dup",
      type: "message.created",
      correlationId: frame.id,
      data: {
        channelId: CHANNEL,
        message: stored("msg_1", cmid, "hello (edited)", { editedAt: "2026-11-27T10:01:00Z" }),
      },
    });

    const list = messagesFor(CHANNEL);
    expect(list.map((m) => m.id)).toEqual(["msg_0", "msg_1"]);
    expect(list[1]).toMatchObject({ pending: false, failed: false, clientMessageId: cmid });
    expect(list[1]?.content.text).toBe("hello (edited)");
    expect(cursorFor(CHANNEL)).toBe(CUR_5);
    expect(ws.cursorFor(CHANNEL)).toBe(CUR_5);
  });

  test("a create dropped before its answer is re-sent; the duplicate answer settles the echo", async () => {
    const { ws, sock } = await openConnected();
    const cmid = sendMessage({ ws, groupId: GROUP, channelId: CHANNEL, author: ME, text: "lost?" });
    const original = lastCreate(sock);
    sock.drop();

    await until(() => FakeWebSocket.instances.length === 2);
    const next = FakeWebSocket.latest();
    next.handshake();
    await until(() => ws.state === "connected");
    const resent = lastCreate(next);
    expect(resent.id).toBe(original.id);
    expect(resent.data.clientMessageId).toBe(cmid);
    expect(messagesFor(CHANNEL)[0]?.pending).toBe(true);

    next.serverSend({
      id: "evt_dup",
      type: "message.created",
      correlationId: resent.id,
      data: { channelId: CHANNEL, message: stored("msg_9", cmid, "lost?") },
    });
    expect(messagesFor(CHANNEL)).toHaveLength(1);
    expect(messagesFor(CHANNEL)[0]).toMatchObject({ id: "msg_9", pending: false });
    expect(cursorFor(CHANNEL)).toBeUndefined();
  });
});

describe("undeliverable sends and retry", () => {
  test("a send the client can never deliver fails; retry resends the whole message under its id", async () => {
    const ws = wsClient();
    void ws.connect().catch(() => undefined);
    const attachment = {
      id: "att_1",
      mime: "image/png",
      url: `https://${HOST}/api/media/att_1`,
      size: 3,
    } as Attachment;
    const cmid = sendMessage({
      ws,
      groupId: GROUP,
      channelId: CHANNEL,
      author: ME,
      text: "pic for @bob",
      type: "memo",
      reference: { type: "reply", id: "msg_parent" },
      attachments: [attachment],
      tags: ["#design"],
    });
    ws.close();
    expect(messagesFor(CHANNEL)[0]).toMatchObject({ failed: true, clientMessageId: cmid });

    // Retry on a fresh, connected client.
    const ws2 = wsClient();
    const connected = ws2.connect();
    const sock = FakeWebSocket.latest();
    sock.handshake();
    await connected;
    retrySend({ ws: ws2, groupId: GROUP, channelId: CHANNEL, clientMessageId: cmid });

    expect(lastCreate(sock).data).toEqual({
      groupId: GROUP,
      channelId: CHANNEL,
      clientMessageId: cmid,
      type: "memo",
      content: { mime: "text/plain", text: "pic for @bob" },
      reference: { type: "reply", id: "msg_parent" },
      attachments: [attachment],
      tags: ["#design"],
      mentions: [`bob@${HOST}`],
    });
    expect(messagesFor(CHANNEL)).toHaveLength(1);
    expect(messagesFor(CHANNEL)[0]?.pending).toBe(true);
    expect(messagesFor(CHANNEL)[0]?.failed).toBeFalsy();
  });

  test("a send on an already-closed client fails its echo without throwing", async () => {
    const ws = wsClient();
    ws.close();
    let cmid = "";
    expect(() => {
      cmid = sendMessage({ ws, groupId: GROUP, channelId: CHANNEL, author: ME, text: "late" });
    }).not.toThrow();
    // Reported once `send` has returned (a microtask later).
    await Promise.resolve();
    expect(messagesFor(CHANNEL)).toHaveLength(1);
    expect(messagesFor(CHANNEL)[0]).toMatchObject({
      clientMessageId: cmid,
      pending: false,
      failed: true,
    });
  });
});

describe("a correlated `error` answering a create (§7.1)", () => {
  for (const [status, code] of [
    [403, "forbidden"],
    [400, "bad_request"],
  ] as const) {
    test(`a ${status} marks the echo failed; a later frame with that id is not its answer`, async () => {
      const { ws, sock } = await openConnected();
      const cmid = sendMessage({ ws, groupId: GROUP, channelId: CHANNEL, author: ME, text: "x" });
      const frame = lastCreate(sock);
      sock.serverSend({
        id: "evt_err",
        type: "error",
        correlationId: frame.id,
        data: { code, status, message: "refused" },
      });
      expect(messagesFor(CHANNEL)).toHaveLength(1);
      expect(messagesFor(CHANNEL)[0]).toMatchObject({
        clientMessageId: cmid,
        pending: false,
        failed: true,
      });

      // The send is settled: a stray `message.created` reusing the frame id no
      // longer reconciles the (failed) echo; it lands as its own message.
      sock.serverSend({
        id: "evt_late",
        type: "message.created",
        correlationId: frame.id,
        data: { channelId: CHANNEL, cursor: CUR_5, message: stored("msg_x", "cmid_x", "other") },
      });
      expect(messagesFor(CHANNEL).map((m) => m.id)).toEqual([`optimistic:${cmid}`, "msg_x"]);
      expect(messagesFor(CHANNEL)[0]?.failed).toBe(true);
    });
  }

  test("an uncorrelated `error`, or one for another frame, leaves the echo pending", async () => {
    const { ws, sock } = await openConnected();
    sendMessage({ ws, groupId: GROUP, channelId: CHANNEL, author: ME, text: "x" });
    sock.serverSend({ id: "e1", type: "error", data: { code: "bad_request", status: 400 } });
    sock.serverSend({
      id: "e2",
      type: "error",
      correlationId: "someone_else",
      data: { code: "forbidden", status: 403 },
    });
    expect(messagesFor(CHANNEL)[0]).toMatchObject({ pending: true });
    expect(messagesFor(CHANNEL)[0]?.failed).toBeFalsy();
  });
});

describe("editMessage resends `mentions` (§5.3 authoritative; §7.1 keeps omitted fields)", () => {
  const lastUpdate = (sock: FakeWebSocket) =>
    sock.sent.filter((f) => f.type === "message.update").at(-1);

  test("the new text's mentions, bare handles at the channel's provider", async () => {
    const { ws, sock } = await openConnected();
    editMessage({
      ws,
      groupId: GROUP,
      channelId: CHANNEL,
      messageId: "msg_1",
      text: "ping @dave and @erin@other.example",
    });
    expect(lastUpdate(sock)?.data).toEqual({
      groupId: GROUP,
      channelId: CHANNEL,
      messageId: "msg_1",
      content: { mime: "text/plain", text: "ping @dave and @erin@other.example" },
      mentions: [`dave@${HOST}`, "erin@other.example"],
    });
  });

  test("an edit that names nobody any more sends `mentions: []`", async () => {
    const { ws, sock } = await openConnected();
    editMessage({ ws, groupId: GROUP, channelId: CHANNEL, messageId: "msg_1", text: "no one" });
    expect((lastUpdate(sock)?.data as { mentions?: unknown }).mentions).toEqual([]);
  });
});
