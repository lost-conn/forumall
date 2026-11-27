/**
 * Direct-WS from a remote member (spec §8.5, §7.1, §7.5), beyond the delivery
 * and loss-of-access paths `federation-realtime.test.ts` covers. A real
 * two-provider federation: `alice` lives on A and connects straight to B, which
 * hosts the group; `bob` is B's local admin.
 *  - subscribe-time enforcement of membership + tier for a remote actor: a
 *    non-member is refused a channel of a non-public group (even a `public`
 *    channel in it) until it joins; a member is refused a `view`-restricted
 *    channel (one `not_found` naming it, the readable ones acked) until a role
 *    change grants it, and a demotion ends that subscription;
 *  - resume (`since`) works for the remote member as locally: messages posted
 *    while it was away replay in current state;
 *  - `member.updated` reaches the remote member's own direct-WS connection;
 *  - presence over the direct WS is filtered for the remote viewer by the
 *    subject's `allowList`/`denyList` (§6.1), on snapshots and live updates.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member, Presence } from "@forumall/shared";

import { createChannel } from "../src/provider/channels.ts";
import { createGroup } from "../src/provider/groups.ts";
import { addMember } from "../src/provider/membership.ts";
import { type FedUser, connectTo, registerOn, signedTo } from "./helpers/federation-users.ts";
import { type Federation, startFederation } from "./helpers/two-provider.ts";
import type { WsClient } from "./helpers/ws-harness.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-fedrt-access-"));
});

const feds: Federation[] = [];
const clients: WsClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const f of feds.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-fedrt-access-"));
});

interface World {
  fed: Federation;
  alice: FedUser;
  bob: FedUser;
  groupId: string;
  /** A `public` channel. */
  general: string;
  /** A channel only `admin` may view (`permissions.view`). */
  staff: string;
}

/** Boot A + B; B hosts an `open`-join group of `groupTier` with two channels. */
async function world(groupTier = "public"): Promise<World> {
  const fed = startFederation(tmp);
  feds.push(fed);
  const alice = await registerOn(fed.a, "alice");
  const bob = await registerOn(fed.b, "bob");
  const group = createGroup(fed.b.db, bob.actor, {
    name: "club",
    tier: groupTier,
    joinPolicy: "open",
  });
  addMember(fed.b.db, group.id, `admin@${fed.b.domain}`, "admin");
  const general = createChannel(fed.b.db, group.id, {
    type: "text",
    name: "general",
    tier: "public",
  });
  const staff = createChannel(fed.b.db, group.id, {
    type: "text",
    name: "staff",
    tier: "public",
    permissions: { view: ["admin"] },
  });
  return { fed, alice, bob, groupId: group.id, general: general.id, staff: staff.id };
}

async function connect(w: World, user: FedUser): Promise<WsClient> {
  const client = await connectTo(w.fed.b, user);
  clients.push(client);
  return client;
}

async function joinGroup(w: World): Promise<void> {
  const res = await signedTo(w.fed.b, w.alice, "POST", `/api/groups/${w.groupId}/join`);
  expect(res.status).toBe(201);
}

async function setRole(w: World, role: string): Promise<void> {
  const path = `/api/groups/${w.groupId}/members/${encodeURIComponent(w.alice.actor)}`;
  expect((await signedTo(w.fed.b, w.bob, "PATCH", path, { role })).status).toBe(200);
}

/** Send `subscribe` and return the ack's channels (or `null`) and any error. */
async function trySubscribe(
  ws: WsClient,
  channels: string[],
  id: string,
  since?: Record<string, string>,
): Promise<{ acked: string[] | null; refused: string[] | null }> {
  ws.send({ id, type: "subscribe", data: { channels, ...(since ? { since } : {}) } });
  const first = await ws.next(
    (f) => f.correlationId === id && (f.type === "subscribed" || f.type === "error"),
  );
  const refusedOf = (f: { data?: unknown }) =>
    ((f.data as { details?: { channels?: string[] } }).details?.channels ?? []) as string[];
  if (first.type === "error") {
    expect((first.data as { code: string }).code).toBe("not_found");
    return { acked: null, refused: refusedOf(first) };
  }
  const acked = (first.data as { channels: string[] }).channels;
  if (acked.length === channels.length) return { acked, refused: null };
  const err = await ws.next((f) => f.correlationId === id && f.type === "error");
  expect((err.data as { code: string }).code).toBe("not_found");
  return { acked, refused: refusedOf(err) };
}

async function post(w: World, text: string): Promise<string> {
  const res = await signedTo(
    w.fed.b,
    w.bob,
    "POST",
    `/api/groups/${w.groupId}/channels/${w.general}/messages`,
    { content: { mime: "text/plain", text } },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("subscribe-time membership + tier for a remote actor (§8.5 step 4)", () => {
  test("a non-member is refused a non-public group's channels, even a public one, until it joins", async () => {
    const w = await world("group");
    const aliceWs = await connect(w, w.alice);

    expect(await trySubscribe(aliceWs, [w.general], "s1")).toEqual({
      acked: null,
      refused: [w.general],
    });

    await joinGroup(w);
    expect(await trySubscribe(aliceWs, [w.general], "s2")).toEqual({
      acked: [w.general],
      refused: null,
    });
  });

  test("a member is refused a view-restricted channel (readable ones acked) until a role grants it; a demotion ends it", async () => {
    const w = await world();
    await joinGroup(w);
    const aliceWs = await connect(w, w.alice);

    expect(await trySubscribe(aliceWs, [w.general, w.staff], "s1")).toEqual({
      acked: [w.general],
      refused: [w.staff],
    });

    await setRole(w, "admin");
    expect(await trySubscribe(aliceWs, [w.staff], "s2")).toEqual({
      acked: [w.staff],
      refused: null,
    });

    await setRole(w, "member");
    const notice = await aliceWs.ofType("unsubscribed");
    expect(notice.data).toEqual({ channels: [w.staff], reason: "access_revoked" });
    expect(aliceWs.closed).toBe(false);
  });
});

describe("resume over the direct WS (§8.5, §7.1)", () => {
  test("a remote member reconnecting with `since` gets what was posted and edited while away, in current state", async () => {
    const w = await world();
    await joinGroup(w);

    const first = await connect(w, w.alice);
    await trySubscribe(first, [w.general], "s1");
    await post(w, "before");
    const seen = await first.ofType("message.created");
    const since = (seen.data as { cursor: string }).cursor;
    first.close();
    await first.waitClosed();

    const m2 = await post(w, "while away");
    const m3 = await post(w, "also away");
    const edit = await signedTo(
      w.fed.b,
      w.bob,
      "PATCH",
      `/api/groups/${w.groupId}/channels/${w.general}/messages/${m2}`,
      { content: { mime: "text/plain", text: "while away (edited)" } },
    );
    expect(edit.status).toBe(200);

    const again = await connect(w, w.alice);
    expect(await trySubscribe(again, [w.general], "s2", { [w.general]: since })).toEqual({
      acked: [w.general],
      refused: null,
    });
    const replayed: [string, string][] = [];
    for (const _ of [m2, m3]) {
      const evt = await again.ofType("message.created");
      const msg = (evt.data as { message: { id: string; content: { text: string } } }).message;
      replayed.push([msg.id, msg.content.text]);
    }
    expect(replayed).toEqual([
      [m2, "while away (edited)"],
      [m3, "also away"],
    ]);
  });
});

describe("member.updated to a remote member's own direct-WS connection (§5.7, §8.5)", () => {
  test("a role change reaches the remote member's connection to the group's provider, subscribed to nothing", async () => {
    const w = await world();
    await joinGroup(w);
    const aliceWs = await connect(w, w.alice);

    await setRole(w, "admin");
    const evt = await aliceWs.ofType("member.updated");
    const data = evt.data as { groupId: string; member: Member };
    expect(data.groupId).toBe(w.groupId);
    expect(data.member).toMatchObject({ user: w.alice.actor, role: "admin" });
  });
});

describe("presence over the direct WS, filtered for the remote viewer (§7.5, §6.1)", () => {
  interface PresenceData {
    user: string;
    presence: Presence;
  }

  async function subscribePresence(ws: WsClient, subject: string): Promise<Presence> {
    ws.send({ id: "psub", type: "presence.subscribe", data: { users: [subject] } });
    await ws.ofType("presence.subscribed");
    return ((await ws.ofType("presence.update")).data as PresenceData).presence;
  }

  async function rest(w: World): Promise<Presence> {
    const res = await signedTo(w.fed.b, w.alice, "GET", "/api/users/bob/presence");
    expect(res.status).toBe(200);
    return (await res.json()) as Presence;
  }

  async function privacy(w: World, body: Record<string, unknown>): Promise<void> {
    expect((await signedTo(w.fed.b, w.bob, "PUT", "/api/me/privacy", body)).status).toBe(200);
  }

  async function setBob(w: World, availability: string): Promise<void> {
    const res = await signedTo(w.fed.b, w.bob, "PUT", "/api/me/presence", { availability });
    expect(res.status).toBe(200);
  }

  test("an allowList naming the remote viewer over `nobody` shows the real state; REST agrees", async () => {
    const w = await world();
    await privacy(w, { presenceVisibility: "nobody", allowList: [w.alice.actor] });
    await connect(w, w.bob);
    const aliceWs = await connect(w, w.alice);

    expect((await subscribePresence(aliceWs, w.bob.actor)).availability).toBe("online");
    await setBob(w, "dnd");
    const live = ((await aliceWs.ofType("presence.update")).data as PresenceData).presence;
    expect(live.availability).toBe("dnd");
    expect(await rest(w)).toEqual(live);
  });

  test("a denyList naming the remote viewer over `public` shows uniform offline; REST agrees", async () => {
    const w = await world();
    await privacy(w, { presenceVisibility: "public", denyList: [w.alice.actor] });
    await connect(w, w.bob);
    const aliceWs = await connect(w, w.alice);
    const offline: Presence = { availability: "offline", metadata: [] };

    expect(await subscribePresence(aliceWs, w.bob.actor)).toEqual(offline);
    await setBob(w, "dnd");
    expect(((await aliceWs.ofType("presence.update")).data as PresenceData).presence).toEqual(
      offline,
    );
    expect(await rest(w)).toEqual(offline);
  });
});
