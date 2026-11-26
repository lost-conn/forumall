/**
 * WebSocket subscription tests (spec §7.1 Subscriptions): authorization at
 * subscribe-time, refused channels (`not_found`, §11.3), partial subscribes,
 * and the all-or-nothing subscription cap.
 *
 * See `helpers/ws-harness.ts` for the real-socket harness.
 */
import { describe, expect, test } from "bun:test";
import type { WsEnvelope } from "@forumall/shared";

import {
  type WsClient,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-ws-subs-");

/** Assert `err` is the single §7.1 refusal for `channels`, correlated to `id`. */
function expectNotFound(err: WsEnvelope, id: string, channels: string[]) {
  expect(err.correlationId).toBe(id);
  expect(err.data).toMatchObject({ code: "not_found", status: 404, details: { channels } });
}

/** True iff no `subscribed` ack and no further `error` reaches `client` shortly. */
async function nothingElse(client: WsClient): Promise<boolean> {
  return client.none((f) => f.type === "subscribed" || f.type === "error", 200);
}

describe("WS subscriptions (§7.1)", () => {
  test("subscribe to an authorized (public) channel → subscribed; unsubscribe → unsubscribed", async () => {
    const b = boot("sub-ok");
    const alice = await registerUserWithKey(b, "alice");
    const { channelId } = await makeGroupChannel(b, alice, { group: "private", channel: "public" });
    const client = await connectAuthenticated(b, alice);

    client.send({ id: "cli_sub", type: "subscribe", data: { channels: [channelId] } });
    const ack = await client.ofType("subscribed");
    expect((ack.data as { channels: string[] }).channels).toEqual([channelId]);
    expect(ack.correlationId).toBe("cli_sub");

    client.send({ id: "cli_unsub", type: "unsubscribe", data: { channels: [channelId] } });
    const un = await client.ofType("unsubscribed");
    expect((un.data as { channels: string[] }).channels).toEqual([channelId]);
    expect(un.correlationId).toBe("cli_unsub");
    client.close();
  });

  test("subscribe to an unreadable (private, non-member) channel → only an error not_found", async () => {
    const b = boot("sub-unreadable");
    const owner = await registerUserWithKey(b, "owner");
    const { channelId } = await makeGroupChannel(b, owner, {
      group: "private",
      channel: "private",
    });
    // bob is NOT a member of the group → cannot see a private channel.
    const bob = await registerUserWithKey(b, "bob");
    const client = await connectAuthenticated(b, bob);

    client.send({ id: "cli_sub", type: "subscribe", data: { channels: [channelId] } });
    expectNotFound(await client.ofType("error"), "cli_sub", [channelId]);
    expect(await nothingElse(client)).toBe(true);
    client.close();
  });

  test("a public channel in a private group (non-member) is refused like a missing one (#24)", async () => {
    const b = boot("sub-unreadable-widen");
    const owner = await registerUserWithKey(b, "owner");
    // A `public` CHANNEL tier must not widen its `private` group's access —
    // effective read access is the more restrictive of the two (§11).
    const { channelId } = await makeGroupChannel(b, owner, { group: "private", channel: "public" });
    const bob = await registerUserWithKey(b, "bob"); // not a group member
    const client = await connectAuthenticated(b, bob);

    client.send({ id: "cli_sub_widen", type: "subscribe", data: { channels: [channelId] } });
    expectNotFound(await client.ofType("error"), "cli_sub_widen", [channelId]);
    client.close();
  });

  test("partial subscribe: subscribed lists the readable channels, then one not_found names the rest", async () => {
    const b = boot("sub-partial");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob");
    const readable = await makeGroupChannel(b, owner);
    const unreadable = await makeGroupChannel(b, owner, { group: "private", channel: "private" });
    const client = await connectAuthenticated(b, bob);

    const channels = [readable.channelId, "chn_missing", unreadable.channelId];
    client.send({ id: "cli_part", type: "subscribe", data: { channels } });
    // Ack first, listing only the readable channel…
    const first = await client.next();
    expect(first.type).toBe("subscribed");
    expect(first.correlationId).toBe("cli_part");
    expect((first.data as { channels: string[] }).channels).toEqual([readable.channelId]);
    // …then ONE error for every refused one; an unknown id and an unreadable
    // one are indistinguishable (§11.3).
    const second = await client.next();
    expect(second.type).toBe("error");
    expectNotFound(second, "cli_part", ["chn_missing", unreadable.channelId]);
    expect(await nothingElse(client)).toBe(true);
    expect(b.hub.subscriberCount(readable.channelId)).toBe(1);
    expect(b.hub.subscriberCount(unreadable.channelId)).toBe(0);
    client.close();
  });
});

describe("WS subscription cap (§7.1, all-or-nothing)", () => {
  const CAP = { WS_MAX_SUBSCRIPTIONS: "2" };

  test("a subscribe that would exceed the cap subscribes none and answers only subscription_limit", async () => {
    const b = boot("cap-exceed", undefined, CAP);
    const alice = await registerUserWithKey(b, "alice");
    const c1 = await makeGroupChannel(b, alice);
    const c2 = await makeGroupChannel(b, alice);
    const c3 = await makeGroupChannel(b, alice);
    const client = await connectAuthenticated(b, alice);

    await subscribe(client, c1.channelId, "s1");
    client.send({
      id: "s2",
      type: "subscribe",
      data: { channels: [c2.channelId, c3.channelId, "chn_missing"] },
    });
    const err = await client.ofType("error");
    expect(err.correlationId).toBe("s2");
    expect(err.data).toMatchObject({ code: "subscription_limit", status: 409 });
    // No `subscribed`, and no `not_found` for the missing channel either.
    expect(await nothingElse(client)).toBe(true);
    expect(b.hub.subscriberCount(c2.channelId)).toBe(0);
    expect(b.hub.subscriberCount(c3.channelId)).toBe(0);
    client.close();
  });

  test("only readable channels not yet subscribed count towards the cap", async () => {
    const b = boot("cap-readable", undefined, CAP);
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob");
    const c1 = await makeGroupChannel(b, owner);
    const c2 = await makeGroupChannel(b, owner);
    const hidden = await makeGroupChannel(b, owner, { group: "private", channel: "private" });
    const client = await connectAuthenticated(b, bob);
    await subscribe(client, c1.channelId, "s1");

    // c1 again (already subscribed) + c2 + two refused ones: 2 readable in
    // total, within the cap — so the unreadable ones reveal nothing via a
    // limit error and are refused as not found.
    client.send({
      id: "s2",
      type: "subscribe",
      data: { channels: [c1.channelId, c2.channelId, hidden.channelId, "chn_missing"] },
    });
    const ack = await client.ofType("subscribed");
    expect((ack.data as { channels: string[] }).channels).toEqual([c1.channelId, c2.channelId]);
    expectNotFound(await client.ofType("error"), "s2", [hidden.channelId, "chn_missing"]);
    client.close();
  });
});
