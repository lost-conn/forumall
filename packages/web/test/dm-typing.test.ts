/**
 * DM typing frames (§7.4): the `dmId` is the command's `channelId` target, the
 * only target field `typing.start` / `typing.stop` have
 * (`schemas/v0.1/ws/typing-start.json`, `typing-stop.json`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deriveDmId, generateKeyPair } from "@forumall/shared";
import { dmTypingStart, dmTypingStop } from "../src/components/dms/dm-typing.ts";
import { OfscpWsClient } from "../src/lib/ofscp-ws.ts";
import { FakeWebSocket } from "./helpers/fake-ws.ts";

const { privateKey } = generateKeyPair();
const clients: OfscpWsClient[] = [];

function makeClient(): OfscpWsClient {
  const client = new OfscpWsClient({
    host: "providera.test",
    actor: "alice@providera.test",
    keyId: "key_1",
    privateKey,
    url: "ws://fake/api/ws",
    // The test double stands in for the DOM WebSocket constructor.
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    autoReconnect: false,
  });
  clients.push(client);
  return client;
}

beforeEach(() => FakeWebSocket.reset());
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

describe("DM typing frames (§7.4)", () => {
  test("start and stop name the conversation as `channelId: dmId`", async () => {
    const client = makeClient();
    const connected = client.connect();
    const sock = FakeWebSocket.latest();
    sock.handshake();
    await connected;
    const dmId = deriveDmId("alice@providera.test", "bob@providerb.test");

    dmTypingStart(client, dmId);
    expect(sock.sent.at(-1)).toMatchObject({ type: "typing.start", data: { channelId: dmId } });
    expect(sock.sent.at(-1)?.data).not.toHaveProperty("dmId");
    dmTypingStop(client, dmId);
    expect(sock.sent.at(-1)).toMatchObject({ type: "typing.stop", data: { channelId: dmId } });
    expect(sock.sent.at(-1)?.data).not.toHaveProperty("dmId");
  });
});
