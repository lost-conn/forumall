/**
 * §7.1 "The requester's own copy": a connection whose timeline or reaction
 * command succeeds gets exactly one copy of the resulting event, carrying the
 * command's `id` in `correlationId` — when it can read the channel but has
 * not subscribed to it, and (never a second, uncorrelated one) when it has.
 * Subscribers still get the event uncorrelated. (That other subscribers'
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
 * Run every step from `requester` and check that it — and the subscribed
 * `watcher` — each get exactly one copy of the step's event: correlated for
 * the requester, uncorrelated for the watcher.
 */
async function runSteps(requester: WsClient, watcher: WsClient, list: Step[]): Promise<void> {
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
    const seen = await watcher.next(isEvent);
    expect(seen.correlationId).toBeUndefined();
    expect(seen.id).toBe(own.id);
    expect(seen.data).toEqual(own.data);
    expect({ step: step.id, second: !(await requester.none(isEvent, 150)) }).toEqual({
      step: step.id,
      second: false,
    });
    if (step.type === "message.create") {
      messageId = (own.data as { message: { id: string } }).message.id;
    }
  }
}

async function setup(name: string): Promise<{
  b: Booted;
  ids: { groupId: string; channelId: string };
  alice: Awaited<ReturnType<typeof registerUserWithKey>>;
  watcher: WsClient;
}> {
  const b = boot(name);
  const alice = await registerUserWithKey(b, "alice");
  const bob = await registerUserWithKey(b, "bob");
  const ids = await makeGroupChannel(b, alice);
  addMember(b, ids.groupId, bob, "member");
  const watcher = await connectAuthenticated(b, bob);
  await subscribe(watcher, ids.channelId);
  return { b, ids, alice, watcher };
}

describe("the requester's own copy (§7.1 Delivery)", () => {
  test("a connection not subscribed to the channel gets exactly one correlated copy of each event", async () => {
    const { b, ids, alice, watcher } = await setup("requester-unsubscribed");
    const requester = await connectAuthenticated(b, alice);
    await runSteps(requester, watcher, steps(ids, "u"));
    requester.close();
    watcher.close();
  });

  test("a subscribed connection gets that same single copy, never a second, uncorrelated one", async () => {
    const { b, ids, alice, watcher } = await setup("requester-subscribed");
    const requester = await connectAuthenticated(b, alice);
    await subscribe(requester, ids.channelId);
    await runSteps(requester, watcher, steps(ids, "s"));
    requester.close();
    watcher.close();
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
