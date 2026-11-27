/**
 * `member.updated` delivery (spec §5.7 "`member.updated` event"):
 *  - it reaches the affected member's own connections, subscribed to nothing,
 *    on a role change and on a nickname change made by someone else;
 *  - an ownership transfer emits it for both members;
 *  - nothing else emits it: a join, a leave and a kick send no `member.updated`
 *    on the group's channels.
 * Channel-subscriber delivery is covered by `display-name.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Member } from "@forumall/shared";

import {
  type Booted,
  type Signer,
  type WsClient,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-member-updated-");

const clients: WsClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

interface MemberUpdated {
  groupId: string;
  member: Member;
}

async function connect(b: Booted, signer: Signer): Promise<WsClient> {
  const client = await connectAuthenticated(b, signer);
  clients.push(client);
  return client;
}

async function memberUpdated(client: WsClient): Promise<MemberUpdated> {
  return (await client.ofType("member.updated")).data as MemberUpdated;
}

function memberPath(groupId: string, actor: string): string {
  return `/api/groups/${groupId}/members/${encodeURIComponent(actor)}`;
}

/** A public, `open`-join group with one public text channel. */
async function openGroupChannel(b: Booted, owner: Signer) {
  const g = await signedReq(b, owner, "POST", "/api/groups", {
    name: "g",
    tier: "public",
    joinPolicy: "open",
  });
  expect(g.status).toBe(201);
  const groupId = ((await g.json()) as { id: string }).id;
  const c = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
    type: "text",
    name: "general",
    tier: "public",
  });
  expect(c.status).toBe(201);
  return { groupId, channelId: ((await c.json()) as { id: string }).id };
}

async function expect200(res: Promise<Response>): Promise<void> {
  expect((await res).status).toBe(200);
}

describe("member.updated to the affected member's own connections (§5.7)", () => {
  test("a role change reaches every connection of the member, subscribed to nothing; no one else unsubscribed", async () => {
    const b = boot("mu-role");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const { groupId } = await openGroupChannel(b, owner);
    for (const m of [bob, carol]) {
      expect((await signedReq(b, m, "POST", `/api/groups/${groupId}/join`)).status).toBe(201);
    }

    const bobPhone = await connect(b, bob);
    const bobLaptop = await connect(b, bob);
    const carolWs = await connect(b, carol);

    await expect200(
      signedReq(b, owner, "PATCH", memberPath(groupId, bob.actor), { role: "admin" }),
    );

    for (const ws of [bobPhone, bobLaptop]) {
      const data = await memberUpdated(ws);
      expect(data.groupId).toBe(groupId);
      expect(data.member).toMatchObject({ user: bob.actor, role: "admin" });
    }
    expect(await carolWs.none((f) => f.type === "member.updated")).toBe(true);
  });

  test("a nickname set by another member reaches the renamed member's own connection", async () => {
    const b = boot("mu-nick");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId } = await openGroupChannel(b, owner);
    expect((await signedReq(b, bob, "POST", `/api/groups/${groupId}/join`)).status).toBe(201);
    const bobWs = await connect(b, bob);

    await expect200(
      signedReq(b, owner, "PATCH", `${memberPath(groupId, bob.actor)}/display-name`, {
        displayNameOverride: "Bobby",
      }),
    );

    const data = await memberUpdated(bobWs);
    expect(data.member).toMatchObject({ user: bob.actor, displayNameOverride: "Bobby" });
  });

  test("an ownership transfer emits member.updated for both members", async () => {
    const b = boot("mu-transfer");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob");
    const watcher = await registerUserWithKey(b, "watcher");
    const { groupId, channelId } = await openGroupChannel(b, owner);
    expect((await signedReq(b, bob, "POST", `/api/groups/${groupId}/join`)).status).toBe(201);

    const ownerWs = await connect(b, owner);
    const bobWs = await connect(b, bob);
    const watcherWs = await connect(b, watcher);
    await subscribe(watcherWs, channelId);

    await expect200(
      signedReq(b, owner, "PATCH", memberPath(groupId, bob.actor), { role: "owner" }),
    );

    // The channel subscriber sees both role changes.
    const seen = [await memberUpdated(watcherWs), await memberUpdated(watcherWs)];
    expect(seen.map((d) => [d.member.user, d.member.role]).sort()).toEqual(
      [
        [bob.actor, "owner"],
        [owner.actor, "admin"],
      ].sort(),
    );
    // Each member's own connection gets its own event.
    expect((await memberUpdated(bobWs)).member).toMatchObject({ user: bob.actor, role: "owner" });
    expect((await memberUpdated(ownerWs)).member).toMatchObject({
      user: owner.actor,
      role: "admin",
    });
  });
});

describe("nothing else emits member.updated (§5.7)", () => {
  test("a join, a leave and a kick send no member.updated on the group's channels", async () => {
    const b = boot("mu-none");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const { groupId, channelId } = await openGroupChannel(b, owner);
    const ownerWs = await connect(b, owner);
    await subscribe(ownerWs, channelId);
    const bobWs = await connect(b, bob);
    const carolWs = await connect(b, carol);

    expect((await signedReq(b, bob, "POST", `/api/groups/${groupId}/join`)).status).toBe(201);
    expect((await signedReq(b, carol, "POST", `/api/groups/${groupId}/join`)).status).toBe(201);
    expect((await signedReq(b, bob, "POST", `/api/groups/${groupId}/leave`)).status).toBe(204);
    expect((await signedReq(b, owner, "DELETE", memberPath(groupId, carol.actor))).status).toBe(
      204,
    );

    for (const ws of [ownerWs, bobWs, carolWs]) {
      expect(await ws.none((f) => f.type === "member.updated", 250)).toBe(true);
    }
  });
});
