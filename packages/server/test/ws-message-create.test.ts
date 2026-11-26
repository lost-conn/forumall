/**
 * WebSocket `message.create` tests (spec §7.1 Sending messages): fan-out,
 * correlation, idempotency and authorization.
 *
 * See `helpers/ws-harness.ts` for the real-socket harness.
 */
import { describe, expect, test } from "bun:test";
import { rfc3339Timestamp } from "@forumall/shared";

import {
  type Booted,
  type Signer,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  signedReq,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-ws-msg-");

describe("WS message.create + fan-out + idempotency (§7.1 Sending messages)", () => {
  /** Count stored messages in a channel via REST history (auth as `signer`). */
  async function historyCount(
    b: Booted,
    signer: Signer,
    groupId: string,
    channelId: string,
  ): Promise<number> {
    const res = await signedReq(
      b,
      signer,
      "GET",
      `/api/groups/${groupId}/channels/${channelId}/messages`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    return body.items.length;
  }

  test("both subscribers receive message.created; author's copy correlates + carries a cursor", async () => {
    const b = boot("msg-fanout");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId, "a_sub");
    await subscribe(bConn, channelId, "b_sub");
    expect(b.hub.subscriberCount(channelId)).toBe(2);

    a.send({
      id: "cli_post_1",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        clientMessageId: "cmsg_1",
        content: { mime: "text/plain", text: "hi" },
      },
    });

    const aEvt = await a.ofType("message.created");
    const bEvt = await bConn.ofType("message.created");

    const { MessageSchema } = await import("@forumall/shared");
    const aData = aEvt.data as { channelId: string; cursor?: string; message: unknown };
    const bData = bEvt.data as { message: { id: string } };

    // Same canonical message reaches both.
    const msg = MessageSchema.parse(aData.message);
    expect(msg.author).toBe(alice.actor);
    expect(msg.content.text).toBe("hi");
    expect(bData.message.id).toBe(msg.id);

    // Author's copy correlates to the request id; event carries a cursor.
    expect(aEvt.correlationId).toBe("cli_post_1");
    expect(typeof aData.cursor).toBe("string");
    expect((aData.cursor as string).length).toBeGreaterThan(0);

    a.close();
    bConn.close();
  });

  test("idempotency: same clientMessageId twice → one stored row, same message id", async () => {
    const b = boot("msg-idempotent");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const a = await connectAuthenticated(b, alice);
    await subscribe(a, channelId);

    const cmd = {
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        clientMessageId: "cmsg_dup",
        content: { mime: "text/plain", text: "once" },
      },
    };
    a.send({ ...cmd, id: "cli_post_a" });
    const first = await a.ofType("message.created");
    const firstId = (first.data as { message: { id: string } }).message.id;

    a.send({ ...cmd, id: "cli_post_b" });
    const second = await a.next(
      (f) => f.type === "message.created" && f.correlationId === "cli_post_b",
    );
    const secondId = (second.data as { message: { id: string } }).message.id;

    // Same canonical id returned; the duplicate's reply correlates to its id.
    expect(secondId).toBe(firstId);
    expect(second.correlationId).toBe("cli_post_b");

    // Exactly one row stored.
    expect(await historyCount(b, alice, groupId, channelId)).toBe(1);

    a.close();
  });

  test("non-member lacking post permission → error forbidden, nothing stored/fanned", async () => {
    const b = boot("msg-forbidden");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob"); // not a member
    const { groupId, channelId } = await makeGroupChannel(b, owner);

    const bobConn = await connectAuthenticated(b, bob);
    // bob can subscribe (public tier) but cannot post (not a member).
    await subscribe(bobConn, channelId);

    bobConn.send({
      id: "cli_post_x",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, content: { mime: "text/plain", text: "nope" } },
    });

    const err = await bobConn.ofType("error");
    expect((err.data as { code: string }).code).toBe("forbidden");
    expect((err.data as { status: number }).status).toBe(403);
    expect(err.correlationId).toBe("cli_post_x");

    // Nothing stored.
    expect(await historyCount(b, owner, groupId, channelId)).toBe(0);

    bobConn.close();
  });

  test("author is taken from the connection, not a spoofed payload author", async () => {
    const b = boot("msg-author");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const a = await connectAuthenticated(b, alice);
    await subscribe(a, channelId);

    a.send({
      id: "cli_post_spoof",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        author: "mallory@evil.test", // spoofed; MUST be ignored
        content: { mime: "text/plain", text: "who am i" },
      },
    });

    const evt = await a.ofType("message.created");
    const msg = (evt.data as { message: { author: string } }).message;
    expect(msg.author).toBe(alice.actor);
    expect(msg.author).not.toBe("mallory@evil.test");

    a.close();
  });
});
