/**
 * Live presence fan-out (spec §7.5), beyond the snapshots `presence.test.ts`
 * covers:
 *  - every live `presence.update` is filtered per (subject, viewer), including
 *    the subject's `allowList`/`denyList` (§6.1), and agrees with
 *    `GET /api/users/{userRef}/presence` for the same viewer;
 *  - `PUT /api/me/presence` fans out like `presence.set`;
 *  - a heartbeat timeout (§7.1 idle close) marks the subject `offline` with a
 *    `lastSeen` and fans that out;
 *  - `presence.unsubscribe` is acked and stops further updates.
 *
 * Runs over a real `Bun.serve` + `new WebSocket` (`helpers/ws-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type Presence, rfc3339Timestamp } from "@forumall/shared";

import {
  type Booted,
  FAST_TIMINGS,
  type Signer,
  type WsClient,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-presence-live-");

const clients: WsClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

interface PresenceData {
  user: string;
  presence: Presence;
}

async function connect(b: Booted, signer: Signer): Promise<WsClient> {
  const client = await connectAuthenticated(b, signer);
  clients.push(client);
  return client;
}

/** Subscribe to `subjects` and return the snapshot sent for each (§7.5). */
async function presenceSubscribe(
  client: WsClient,
  subjects: string[],
): Promise<Map<string, Presence>> {
  client.send({ id: "psub", type: "presence.subscribe", data: { users: subjects } });
  await client.ofType("presence.subscribed");
  const snapshots = new Map<string, Presence>();
  for (const _ of subjects) {
    const d = (await client.ofType("presence.update")).data as PresenceData;
    snapshots.set(d.user, d.presence);
  }
  return snapshots;
}

/** The next `presence.update` about `subject`. */
async function nextUpdate(client: WsClient, subject: string): Promise<Presence> {
  const frame = await client.next(
    (f) => f.type === "presence.update" && (f.data as PresenceData).user === subject,
  );
  return (frame.data as PresenceData).presence;
}

async function restPresence(b: Booted, viewer: Signer, subject: Signer): Promise<Presence> {
  const res = await signedReq(b, viewer, "GET", `/api/users/${subject.handle}/presence`);
  expect(res.status).toBe(200);
  return (await res.json()) as Presence;
}

async function putPrivacy(b: Booted, subject: Signer, body: Record<string, unknown>) {
  const res = await signedReq(b, subject, "PUT", "/api/me/privacy", body);
  expect(res.status).toBe(200);
}

function setPresence(client: WsClient, availability: string, status?: string): void {
  client.send({
    id: `pset-${availability}`,
    type: "presence.set",
    ts: rfc3339Timestamp(),
    data: { availability, ...(status !== undefined ? { status } : {}) },
  });
}

/** The uniform presence an unauthorized viewer gets (§7.5): no status/lastSeen. */
const UNIFORM_OFFLINE: Presence = { availability: "offline", metadata: [] };

describe("live presence.update is filtered per (subject, viewer) (§7.5, §6.1)", () => {
  test("allowList over a `nobody` policy: the listed viewer gets the real update, others uniform offline", async () => {
    const b = boot("live-allow");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    await putPrivacy(b, alice, { presenceVisibility: "nobody", allowList: [bob.actor] });

    const aliceWs = await connect(b, alice);
    const bobWs = await connect(b, bob);
    const carolWs = await connect(b, carol);
    expect((await presenceSubscribe(bobWs, [alice.actor])).get(alice.actor)?.availability).toBe(
      "online",
    );
    expect((await presenceSubscribe(carolWs, [alice.actor])).get(alice.actor)).toEqual(
      UNIFORM_OFFLINE,
    );

    setPresence(aliceWs, "dnd", "focus");
    const toBob = await nextUpdate(bobWs, alice.actor);
    expect(toBob.availability).toBe("dnd");
    expect(toBob.status).toBe("focus");
    expect(await nextUpdate(carolWs, alice.actor)).toEqual(UNIFORM_OFFLINE);

    // Both surfaces agree for each viewer.
    expect(await restPresence(b, bob, alice)).toEqual(toBob);
    expect(await restPresence(b, carol, alice)).toEqual(UNIFORM_OFFLINE);
  });

  test("denyList beats a `public` policy on every live update, and agrees with REST", async () => {
    const b = boot("live-deny");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    await putPrivacy(b, alice, { presenceVisibility: "public", denyList: [carol.actor] });

    const aliceWs = await connect(b, alice);
    const bobWs = await connect(b, bob);
    const carolWs = await connect(b, carol);
    await presenceSubscribe(bobWs, [alice.actor]);
    expect((await presenceSubscribe(carolWs, [alice.actor])).get(alice.actor)).toEqual(
      UNIFORM_OFFLINE,
    );

    setPresence(aliceWs, "away", "lunch");
    const toBob = await nextUpdate(bobWs, alice.actor);
    expect(toBob.availability).toBe("away");
    expect(toBob.status).toBe("lunch");
    expect(await nextUpdate(carolWs, alice.actor)).toEqual(UNIFORM_OFFLINE);
    expect(await restPresence(b, bob, alice)).toEqual(toBob);
    expect(await restPresence(b, carol, alice)).toEqual(UNIFORM_OFFLINE);

    // Going offline is filtered too: bob gets the real `offline` + `lastSeen`,
    // carol the same uniform `offline` (no `lastSeen` leaks the moment).
    aliceWs.close();
    const offToBob = await nextUpdate(bobWs, alice.actor);
    expect(offToBob.availability).toBe("offline");
    expect(typeof offToBob.lastSeen).toBe("string");
    expect(await nextUpdate(carolWs, alice.actor)).toEqual(UNIFORM_OFFLINE);
    expect(await restPresence(b, bob, alice)).toEqual(offToBob);
    expect(await restPresence(b, carol, alice)).toEqual(UNIFORM_OFFLINE);
  });
});

describe("PUT /api/me/presence fans out like presence.set (§7.5 reconciliation)", () => {
  test("a REST presence change reaches WS subscribers, filtered per viewer", async () => {
    const b = boot("live-put");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    await putPrivacy(b, alice, { presenceVisibility: "public", denyList: [carol.actor] });

    await connect(b, alice);
    const bobWs = await connect(b, bob);
    const carolWs = await connect(b, carol);
    await presenceSubscribe(bobWs, [alice.actor]);
    await presenceSubscribe(carolWs, [alice.actor]);

    const put = await signedReq(b, alice, "PUT", "/api/me/presence", {
      availability: "dnd",
      status: "deep work",
    });
    expect(put.status).toBe(200);

    const toBob = await nextUpdate(bobWs, alice.actor);
    expect(toBob.availability).toBe("dnd");
    expect(toBob.status).toBe("deep work");
    expect(await nextUpdate(carolWs, alice.actor)).toEqual(UNIFORM_OFFLINE);
  });
});

describe("heartbeat timeout → offline (§7.5, §7.1)", () => {
  test("an idle-closed connection marks the subject offline with lastSeen and fans it out", async () => {
    // The idle sweep runs every ping interval; a connection that sends nothing
    // for `idleTimeoutMs` is closed (1000) — the heartbeat timeout.
    const b = boot("live-idle", { ...FAST_TIMINGS, pingIntervalMs: 50, idleTimeoutMs: 400 });
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await putPrivacy(b, alice, { presenceVisibility: "public" });

    const aliceWs = await connect(b, alice);
    const bobWs = await connect(b, bob);
    // bob stays live by answering every heartbeat ping with a pong (§7.1).
    bobWs.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as { type: string };
      if (frame.type === "ping") bobWs.send({ id: `pong-${Date.now()}`, type: "pong", data: {} });
    });
    expect((await presenceSubscribe(bobWs, [alice.actor])).get(alice.actor)?.availability).toBe(
      "online",
    );

    const before = Date.now();
    // alice never answers a ping: the server closes her socket normally.
    await aliceWs.waitClosed(3000);
    expect(aliceWs.closeCode).toBe(1000);

    const update = await nextUpdate(bobWs, alice.actor);
    expect(update.availability).toBe("offline");
    expect(update.lastSeen).toBeDefined();
    expect(Date.parse(update.lastSeen as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(bobWs.closed).toBe(false);
    expect(await restPresence(b, bob, alice)).toEqual(update);
  });
});

describe("presence.unsubscribe (§7.5)", () => {
  test("acks presence.unsubscribed and stops updates for the listed users only", async () => {
    const b = boot("live-unsub");
    const alice = await registerUserWithKey(b, "alice");
    const carol = await registerUserWithKey(b, "carol");
    const bob = await registerUserWithKey(b, "bob");
    await putPrivacy(b, alice, { presenceVisibility: "public" });
    await putPrivacy(b, carol, { presenceVisibility: "public" });

    const aliceWs = await connect(b, alice);
    const carolWs = await connect(b, carol);
    const bobWs = await connect(b, bob);
    await presenceSubscribe(bobWs, [alice.actor, carol.actor]);

    bobWs.send({ id: "punsub", type: "presence.unsubscribe", data: { users: [alice.actor] } });
    const ack = await bobWs.ofType("presence.unsubscribed");
    expect(ack.correlationId).toBe("punsub");
    expect(ack.data).toEqual({ users: [alice.actor] });

    setPresence(aliceWs, "dnd");
    setPresence(carolWs, "away");
    // carol's update still arrives; alice's never does.
    expect((await nextUpdate(bobWs, carol.actor)).availability).toBe("away");
    expect(
      await bobWs.none(
        (f) => f.type === "presence.update" && (f.data as PresenceData).user === alice.actor,
        250,
      ),
    ).toBe(true);
  });
});
