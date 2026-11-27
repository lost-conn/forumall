/**
 * §7.1 "The requester's own copy": a connection whose timeline or reaction
 * command succeeds gets exactly one copy of the resulting event, carrying the
 * command's `id` in `correlationId` — when it can read the channel but has
 * not subscribed to it, and (never a second, uncorrelated one) when it has.
 * Subscribers — another user, and the requester's own other connection —
 * each still get the event once, uncorrelated. (That other subscribers'
 * copies are uncorrelated, one frame id for all, is `ws-correlation.test.ts`.)
 */
import { describe, expect, test } from "bun:test";
import { type WsEnvelope, rfc3339Timestamp } from "@forumall/shared";

import {
  type Booted,
  type WsClient,
  addMember,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-ws-requester-copy-");

interface Step {
  readonly id: string;
  readonly type: string;
  readonly event: string;
  readonly data: (messageId: string) => Record<string, unknown>;
}

/** create → update → react → unreact → delete, each over the target ids. */
function steps(ids: { groupId: string; channelId: string }, prefix: string): Step[] {
  return [
    {
      id: `${prefix}_create`,
      type: "message.create",
      event: "message.created",
      data: () => ({ ...ids, content: { mime: "text/plain", text: "hi" } }),
    },
    {
      id: `${prefix}_update`,
      type: "message.update",
      event: "message.updated",
      data: (messageId) => ({ ...ids, messageId, content: { mime: "text/plain", text: "edit" } }),
    },
    {
      id: `${prefix}_react`,
      type: "reaction.add",
      event: "reaction.added",
      data: (messageId) => ({ ...ids, messageId, key: "heart" }),
    },
    {
      id: `${prefix}_unreact`,
      type: "reaction.remove",
      event: "reaction.removed",
      data: (messageId) => ({ ...ids, messageId, key: "heart" }),
    },
    {
      id: `${prefix}_delete`,
      type: "message.delete",
      event: "message.deleted",
      data: (messageId) => ({ ...ids, messageId }),
    },
  ];
}

/**
 * Run every step from `requester` and check that it — and each subscribed
 * watcher — gets exactly one copy of the step's event: correlated for the
 * requester, uncorrelated for every watcher.
 */
async function runSteps(
  requester: WsClient,
  watchers: readonly WsClient[],
  list: Step[],
): Promise<void> {
  let messageId = "";
  for (const step of list) {
    requester.send({
      id: step.id,
      type: step.type,
      ts: rfc3339Timestamp(),
      data: step.data(messageId),
    });
    const isEvent = (f: WsEnvelope) => f.type === step.event;
    const own = await requester.next(isEvent);
    expect({ step: step.id, correlationId: own.correlationId }).toEqual({
      step: step.id,
      correlationId: step.id,
    });
    for (const [i, watcher] of watchers.entries()) {
      const seen = await watcher.next(isEvent);
      expect({ step: step.id, watcher: i, correlationId: seen.correlationId }).toEqual({
        step: step.id,
        watcher: i,
        correlationId: undefined,
      });
      expect(seen.id).toBe(own.id);
      expect(seen.data).toEqual(own.data);
    }
    for (const [i, conn] of [requester, ...watchers].entries()) {
      // 0 = the requester, then each watcher: none gets a second copy.
      expect({ step: step.id, conn: i, second: !(await conn.none(isEvent, 150)) }).toEqual({
        step: step.id,
        conn: i,
        second: false,
      });
    }
    if (step.type === "message.create") {
      messageId = (own.data as { message: { id: string } }).message.id;
    }
  }
}

/**
 * alice owns a channel; bob (a member) and alice's own other connection are
 * subscribed to it as watchers.
 */
async function setup(name: string): Promise<{
  b: Booted;
  ids: { groupId: string; channelId: string };
  alice: Awaited<ReturnType<typeof registerUserWithKey>>;
  watchers: WsClient[];
}> {
  const b = boot(name);
  const alice = await registerUserWithKey(b, "alice");
  const bob = await registerUserWithKey(b, "bob");
  const ids = await makeGroupChannel(b, alice);
  addMember(b, ids.groupId, bob, "member");
  const bobConn = await connectAuthenticated(b, bob);
  await subscribe(bobConn, ids.channelId);
  const aliceOther = await connectAuthenticated(b, alice);
  await subscribe(aliceOther, ids.channelId);
  return { b, ids, alice, watchers: [bobConn, aliceOther] };
}

describe("the requester's own copy (§7.1 Delivery)", () => {
  test("a connection not subscribed to the channel gets exactly one correlated copy of each event", async () => {
    const { b, ids, alice, watchers } = await setup("requester-unsubscribed");
    const requester = await connectAuthenticated(b, alice);
    await runSteps(requester, watchers, steps(ids, "u"));
    requester.close();
    for (const w of watchers) w.close();
  });

  test("a subscribed connection gets that same single copy, never a second, uncorrelated one", async () => {
    const { b, ids, alice, watchers } = await setup("requester-subscribed");
    const requester = await connectAuthenticated(b, alice);
    await subscribe(requester, ids.channelId);
    await runSteps(requester, watchers, steps(ids, "s"));
    requester.close();
    for (const w of watchers) w.close();
  });

  test("an unsubscribed requester gets its copy of a channel no one is subscribed to", async () => {
    const b = boot("requester-alone");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const requester = await connectAuthenticated(b, alice);
    requester.send({
      id: "solo",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: { ...ids, content: { mime: "text/plain", text: "anyone?" } },
    });
    const own = await requester.next((f) => f.type === "message.created");
    expect(own.correlationId).toBe("solo");
    expect(typeof (own.data as { cursor?: string }).cursor).toBe("string");
    requester.close();
  });
});
