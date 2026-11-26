/**
 * Connection hub fan-out tests (spec §7.1): channel and actor delivery and
 * cleanup of closed connections.
 *
 * See `helpers/ws-harness.ts` for the real-socket harness.
 */
import { describe, expect, test } from "bun:test";
import { rfc3339Timestamp, sign } from "@forumall/shared";

import {
  http,
  DOMAIN,
  connectAuthenticated,
  registerUserWithKey,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-ws-hub-");

describe("Hub fan-out (§7.1)", () => {
  test("publishToChannel delivers to all connections subscribed to the channel", async () => {
    const b = boot("hub-fanout");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    // A public channel so both can subscribe without membership.
    const { sign } = await import("@forumall/shared");
    const headers = sign({
      actor: alice.actor,
      keyId: alice.keyId,
      privateKey: alice.privateKey,
      authority: DOMAIN,
      method: "POST",
      path: "/api/groups",
      body: JSON.stringify({ name: "g", tier: "public" }),
    }).headers;
    const gRes = await http(b, "/api/groups", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "g", tier: "public" }),
    });
    const groupId = ((await gRes.json()) as { id: string }).id;
    const chPath = `/api/groups/${groupId}/channels`;
    const chHeaders = sign({
      actor: alice.actor,
      keyId: alice.keyId,
      privateKey: alice.privateKey,
      authority: DOMAIN,
      method: "POST",
      path: chPath,
      body: JSON.stringify({ type: "text", tier: "public" }),
    }).headers;
    const cRes = await http(b, chPath, {
      method: "POST",
      headers: { ...chHeaders, "content-type": "application/json" },
      body: JSON.stringify({ type: "text", tier: "public" }),
    });
    const channelId = ((await cRes.json()) as { id: string }).id;

    const c1 = await connectAuthenticated(b, alice);
    const c2 = await connectAuthenticated(b, bob);
    for (const [c, id] of [
      [c1, "s1"],
      [c2, "s2"],
    ] as const) {
      c.send({ id, type: "subscribe", ts: rfc3339Timestamp(), data: { channels: [channelId] } });
      await c.ofType("subscribed");
    }
    expect(b.hub.subscriberCount(channelId)).toBe(2);

    // Publish directly via the hub (the message-create card will do this).
    b.hub.publishToChannel(channelId, {
      type: "message.created",
      data: { channelId, marker: "hello" },
    });
    const f1 = await c1.ofType("message.created");
    const f2 = await c2.ofType("message.created");
    expect((f1.data as { marker: string }).marker).toBe("hello");
    expect((f2.data as { marker: string }).marker).toBe("hello");
    c1.close();
    c2.close();
  });

  test("publishToActor delivers to that actor's connection", async () => {
    const b = boot("hub-actor");
    const alice = await registerUserWithKey(b, "alice");
    const client = await connectAuthenticated(b, alice);
    b.hub.publishToActor(alice.actor, { type: "dm.message", data: { marker: "dm" } });
    const f = await client.ofType("dm.message");
    expect((f.data as { marker: string }).marker).toBe("dm");
    client.close();
  });

  test("a closed connection is removed from the hub", async () => {
    const b = boot("hub-cleanup");
    const alice = await registerUserWithKey(b, "alice");
    const client = await connectAuthenticated(b, alice);
    expect(b.hub.size).toBe(1);
    client.close();
    // Give the server a tick to process the close.
    await Bun.sleep(50);
    expect(b.hub.size).toBe(0);
  });
});
