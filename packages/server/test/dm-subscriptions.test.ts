/**
 * `dmId` subscriptions (spec §7.4 "Real-time", §8.5) over a real two-provider
 * federation: alice lives on A, bob and dave on B.
 *
 *  - A remote participant (alice) opens a direct WS to the recipient's provider
 *    (B), subscribes with the `dmId` — before any message exists — and follows
 *    her sent messages there: their `dm.message` (create, edit, delete) and
 *    every `dm.reaction` on them, by either participant. Each exactly once.
 *  - Without that subscription a remote connection gets no DM events.
 *  - `since` resume replays the subscriber's view in the DM cursor space, or
 *    reports `truncated` past `MAX_RESUME_REPLAY`.
 *  - A local participant both implicitly addressed and subscribed gets one
 *    frame per event.
 *  - A non-participant gets exactly the answer an unknown `dmId` gets, on every
 *    DM path (WS subscribe and typing, every REST route, the federation ingest).
 *  - `dm.conversation` on a pointer PUT and on a local→local send, and the
 *    remaining 400/403 checks of the send and pointer routes.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WsEnvelope, deriveDmId } from "@forumall/shared";

import { type FedUser, connectTo, registerOn, signedTo } from "./helpers/federation-users.ts";
import {
  type Federation,
  type StartFederationOptions,
  startFederation,
} from "./helpers/two-provider.ts";
import type { WsClient } from "./helpers/ws-harness.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-dmsub-"));
});

const open: Federation[] = [];
const clients: WsClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const f of open.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-dmsub-"));
});

function boot(opts: StartFederationOptions = {}): Federation {
  const fed = startFederation(tmp, opts);
  open.push(fed);
  return fed;
}

async function ws(p: Federation["a"], user: FedUser): Promise<WsClient> {
  const client = await connectTo(p, user);
  clients.push(client);
  return client;
}

/** Subscribe and return the `subscribed` ack's data. */
async function subscribeDm(
  client: WsClient,
  dmId: string,
  since?: string,
): Promise<{ channels: string[]; truncated?: string[] }> {
  client.send({
    id: "sub",
    type: "subscribe",
    data: { channels: [dmId], ...(since !== undefined ? { since: { [dmId]: since } } : {}) },
  });
  return (await client.ofType("subscribed")).data as { channels: string[]; truncated?: string[] };
}

interface DmMessageData {
  dmId: string;
  cursor: string;
  message: {
    id: string;
    author: string;
    content: { text: string };
    editedAt?: string;
    deletedAt?: string;
  };
}

const isDm = (f: WsEnvelope) => f.type.startsWith("dm.");

/** Deliver a DM from `from` to the conversation on `p` (§7.4 send path). */
async function send(
  p: Federation["a"],
  from: FedUser,
  dmId: string,
  text: string,
  cmid: string,
): Promise<{ id: string; cursor?: string }> {
  const res = await signedTo(p, from, "POST", `/api/federation/dms/${dmId}/messages`, {
    clientMessageId: cmid,
    content: { mime: "text/plain", text },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("a remote participant's dmId subscription (§7.4, §8.5)", () => {
  test("follows its sent messages on the recipient's provider: create, reactions, edit, delete", async () => {
    const fed = boot();
    const alice = await registerOn(fed.a, "alice");
    const bob = await registerOn(fed.b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // Subscribed before any message or conversation row exists on B.
    const aliceOnB = await ws(fed.b, alice);
    expect((await subscribeDm(aliceOnB, dmId)).channels).toEqual([dmId]);
    const bobOnB = await ws(fed.b, bob);

    const sent = await send(fed.b, alice, dmId, "hi bob", "cmsg_1");
    const created = (await aliceOnB.ofType("dm.message")).data as DmMessageData;
    expect(created.dmId).toBe(dmId);
    expect(created.message.id).toBe(sent.id);
    expect(created.message.author).toBe(alice.actor);
    expect(typeof created.cursor).toBe("string");
    expect(((await bobOnB.ofType("dm.message")).data as DmMessageData).message.id).toBe(sent.id);

    // bob reacts to alice's message (stored in his inbox) and takes it back.
    const reactPath = `/api/dms/${dmId}/messages/${sent.id}/reactions/heart`;
    expect((await signedTo(fed.b, bob, "PUT", reactPath)).status).toBe(201);
    const added = (await aliceOnB.ofType("dm.reaction")).data as Record<string, unknown>;
    expect(added).toMatchObject({ dmId, messageId: sent.id, state: "added", author: bob.actor });
    expect((await signedTo(fed.b, bob, "DELETE", reactPath)).status).toBe(204);
    const removed = (await aliceOnB.ofType("dm.reaction")).data as Record<string, unknown>;
    expect(removed).toMatchObject({ state: "removed", author: bob.actor, key: "heart" });

    // alice reacts to her own message through the federation ingest.
    const fedReact = `/api/federation/dms/${dmId}/messages/${sent.id}/reactions/star`;
    expect((await signedTo(fed.b, alice, "PUT", fedReact)).status).toBe(200);
    const own = (await aliceOnB.ofType("dm.reaction")).data as Record<string, unknown>;
    expect(own).toMatchObject({ state: "added", author: alice.actor, key: "star" });

    // alice edits, then deletes: both re-sent as `dm.message` with the same id.
    const msgPath = `/api/federation/dms/${dmId}/messages/${sent.id}`;
    const edit = await signedTo(fed.b, alice, "PATCH", msgPath, {
      content: { mime: "text/plain", text: "hi bob!" },
    });
    expect(edit.status).toBe(200);
    const edited = (await aliceOnB.ofType("dm.message")).data as DmMessageData;
    expect(edited.message.id).toBe(sent.id);
    expect(edited.message.content.text).toBe("hi bob!");
    expect(typeof edited.message.editedAt).toBe("string");
    expect((await signedTo(fed.b, alice, "DELETE", msgPath)).status).toBe(204);
    const deleted = (await aliceOnB.ofType("dm.message")).data as DmMessageData;
    expect(deleted.message.id).toBe(sent.id);
    expect(typeof deleted.message.deletedAt).toBe("string");

    // Each event arrived once: nothing DM-shaped is left over.
    expect(await aliceOnB.none(isDm, 300)).toBe(true);
  });

  test("a remote connection without the subscription receives no DM events", async () => {
    const fed = boot();
    const alice = await registerOn(fed.a, "alice");
    const bob = await registerOn(fed.b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const aliceOnB = await ws(fed.b, alice);

    const sent = await send(fed.b, alice, dmId, "hi", "cmsg_1");
    const reactPath = `/api/dms/${dmId}/messages/${sent.id}/reactions/heart`;
    expect((await signedTo(fed.b, bob, "PUT", reactPath)).status).toBe(201);
    const fedReact = `/api/federation/dms/${dmId}/messages/${sent.id}/reactions/star`;
    expect((await signedTo(fed.b, alice, "PUT", fedReact)).status).toBe(200);

    expect(await aliceOnB.none(isDm, 300)).toBe(true);
  });

  test("`since` resumes in the DM cursor space, in current state, for remote and local subscribers", async () => {
    const fed = boot();
    const alice = await registerOn(fed.a, "alice");
    const bob = await registerOn(fed.b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const m1 = await send(fed.b, alice, dmId, "one", "cmsg_1");
    const m2 = await send(fed.b, alice, dmId, "two", "cmsg_2");
    const m3 = await send(fed.b, alice, dmId, "three", "cmsg_3");
    const edit = await signedTo(
      fed.b,
      alice,
      "PATCH",
      `/api/federation/dms/${dmId}/messages/${m2.id}`,
      {
        content: { mime: "text/plain", text: "two (edited)" },
      },
    );
    expect(edit.status).toBe(200);

    // The cursor of m1, as the history read hands it out.
    const hist = await signedTo(fed.b, alice, "GET", `/api/dms/${dmId}/messages?direction=forward`);
    const items = ((await hist.json()) as { items: { id: string; cursor: string }[] }).items;
    const since = items.find((i) => i.id === m1.id)?.cursor as string;
    expect(typeof since).toBe("string");

    for (const user of [alice, bob]) {
      const conn = await ws(fed.b, user);
      const ack = await subscribeDm(conn, dmId, since);
      expect(ack.truncated).toBeUndefined();
      const first = await conn.ofType("dm.message");
      const second = await conn.ofType("dm.message");
      expect(first.correlationId).toBe("sub");
      const [d1, d2] = [first.data as DmMessageData, second.data as DmMessageData];
      expect([d1.message.id, d2.message.id]).toEqual([m2.id, m3.id]);
      expect(d1.message.content.text).toBe("two (edited)");
      expect(await conn.none(isDm, 200)).toBe(true);
    }
  });

  test("a gap larger than MAX_RESUME_REPLAY is reported `truncated`, not replayed", async () => {
    const fed = boot({ envB: { MAX_RESUME_REPLAY: "1" } });
    const alice = await registerOn(fed.a, "alice");
    const bob = await registerOn(fed.b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    await send(fed.b, alice, dmId, "one", "cmsg_1");
    await send(fed.b, alice, dmId, "two", "cmsg_2");
    await send(fed.b, alice, dmId, "three", "cmsg_3");
    const hist = await signedTo(fed.b, alice, "GET", `/api/dms/${dmId}/messages?direction=forward`);
    const since = ((await hist.json()) as { items: { cursor: string }[] }).items[0]
      ?.cursor as string;

    const conn = await ws(fed.b, alice);
    const ack = await subscribeDm(conn, dmId, since);
    expect(ack).toEqual({ channels: [dmId], truncated: [dmId] });
    expect(await conn.none(isDm, 200)).toBe(true);
  });
});

describe("local participants (§7.4)", () => {
  test("a participant both implicitly addressed and subscribed gets each event once", async () => {
    const fed = boot();
    const bob = await registerOn(fed.b, "bob");
    const dave = await registerOn(fed.b, "dave");
    const dmId = deriveDmId(dave.actor, bob.actor);
    const daveConn = await ws(fed.b, dave);
    expect((await subscribeDm(daveConn, dmId)).channels).toEqual([dmId]);

    // dave's own sent message reaches his subscription (it sits in bob's inbox).
    const sent = await send(fed.b, dave, dmId, "hey", "cmsg_1");
    const created = (await daveConn.ofType("dm.message")).data as DmMessageData;
    expect(created.message.id).toBe(sent.id);
    // bob's reaction reaches dave implicitly (a local participant) AND through
    // his subscription (author of the message): one frame.
    expect(
      (await signedTo(fed.b, bob, "PUT", `/api/dms/${dmId}/messages/${sent.id}/reactions/ok`))
        .status,
    ).toBe(201);
    expect(((await daveConn.ofType("dm.reaction")).data as { author: string }).author).toBe(
      bob.actor,
    );
    expect(
      await daveConn.none((f) => f.type === "dm.message" || f.type === "dm.reaction", 300),
    ).toBe(true);
  });

  test("a local→local send emits `dm.conversation` to the sender", async () => {
    const fed = boot();
    const bob = await registerOn(fed.b, "bob");
    const dave = await registerOn(fed.b, "dave");
    const dmId = deriveDmId(dave.actor, bob.actor);
    const daveConn = await ws(fed.b, dave);

    const sent = await send(fed.b, dave, dmId, "hey", "cmsg_1");
    const evt = await daveConn.ofType("dm.conversation");
    const conv = (evt.data as { conversation: Record<string, unknown> }).conversation;
    expect(conv).toMatchObject({ id: dmId, participants: [dave.actor, bob.actor] });
    expect((conv.lastMessage as { id: string }).id).toBe(sent.id);
  });

  test("PUT /api/me/dms/{dmId} emits `dm.conversation` to all of the caller's connections", async () => {
    const fed = boot();
    const alice = await registerOn(fed.a, "alice");
    const dmId = deriveDmId(alice.actor, `bob@${fed.b.domain}`);
    const laptop = await ws(fed.a, alice);
    const phone = await ws(fed.a, alice);

    const res = await signedTo(fed.a, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: `bob@${fed.b.domain}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    for (const conn of [laptop, phone]) {
      const evt = await conn.ofType("dm.conversation");
      expect((evt.data as { conversation: unknown }).conversation).toEqual(body);
    }
    expect(body).toMatchObject({ id: dmId, participants: [alice.actor, `bob@${fed.b.domain}`] });
  });
});

describe("send and pointer checks (§7.4)", () => {
  test("a `to` naming a user of another provider → 400, nothing stored", async () => {
    const fed = boot();
    const alice = await registerOn(fed.a, "alice");
    await registerOn(fed.b, "bob");
    const zed = `zed@${fed.a.domain}`;
    const dmId = deriveDmId(alice.actor, zed);
    const res = await signedTo(fed.b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "cmsg_1",
      to: zed,
      content: { mime: "text/plain", text: "misrouted" },
    });
    expect(res.status).toBe(400);
    const rows = fed.b.db.sqlite.query("SELECT COUNT(*) AS n FROM dm_messages").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  test("a pointer whose `with` is the caller → 400", async () => {
    const fed = boot();
    const alice = await registerOn(fed.a, "alice");
    const dmId = deriveDmId(alice.actor, alice.actor);
    const res = await signedTo(fed.a, alice, "PUT", `/api/me/dms/${dmId}`, { with: alice.actor });
    expect(res.status).toBe(400);
  });

  test("a remote actor on PUT /api/me/dms/{dmId} → 403", async () => {
    const fed = boot();
    const alice = await registerOn(fed.a, "alice");
    const bob = await registerOn(fed.b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const res = await signedTo(fed.b, alice, "PUT", `/api/me/dms/${dmId}`, { with: bob.actor });
    expect(res.status).toBe(403);
  });
});

describe("a non-participant gets the unknown-dmId answer on every DM path", () => {
  /** `dm_` + 64 hex digits that derives from no pair of users here. */
  const UNKNOWN = `dm_${"0".repeat(64)}`;

  async function setup() {
    const fed = boot();
    const alice = await registerOn(fed.a, "alice");
    const bob = await registerOn(fed.b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const sent = await send(fed.b, alice, dmId, "private", "cmsg_1");
    // A reaction on it, so the reaction routes have something to hide.
    await signedTo(fed.b, bob, "PUT", `/api/dms/${dmId}/messages/${sent.id}/reactions/heart`);
    return { fed, dmId, messageId: sent.id };
  }

  /** Every REST DM path for a conversation id + message id. */
  function paths(dmId: string, messageId: string): [string, string, unknown?][] {
    const msg = `/api/dms/${dmId}/messages/${messageId}`;
    const fedMsg = `/api/federation/dms/${dmId}/messages/${messageId}`;
    const text = { mime: "text/plain", text: "x" };
    return [
      ["GET", `/api/dms/${dmId}/messages`],
      ["GET", `${msg}/replies`],
      ["PATCH", msg, { content: text }],
      ["DELETE", msg],
      ["PUT", `${msg}/reactions/heart`],
      ["DELETE", `${msg}/reactions/heart`],
      [
        "POST",
        `/api/federation/dms/${dmId}/messages`,
        { clientMessageId: "cmsg_x", content: text },
      ],
      ["PATCH", fedMsg, { content: text }],
      ["DELETE", fedMsg],
      ["PUT", `${fedMsg}/reactions/heart`],
      ["DELETE", `${fedMsg}/reactions/heart`],
    ];
  }

  for (const where of ["local", "remote"] as const) {
    test(`REST: a ${where} non-participant`, async () => {
      const { fed, dmId, messageId } = await setup();
      const carol = await registerOn(where === "local" ? fed.b : fed.a, "carol");
      const known = paths(dmId, messageId);
      const unknown = paths(UNKNOWN, messageId);
      for (const [i, [method, path, body]] of known.entries()) {
        const [, unknownPath, unknownBody] = unknown[i] as [string, string, unknown?];
        const a = await signedTo(fed.b, carol, method, path, body);
        const b = await signedTo(fed.b, carol, method, unknownPath, unknownBody);
        const label = `${method} ${path}`;
        expect({ label, status: a.status }).toEqual({ label, status: b.status });
        expect([400, 404]).toContain(a.status);
        expect({ label, body: await a.json() }).toEqual({ label, body: await b.json() });
      }
      // Nothing was written into the conversation.
      const n = fed.b.db.sqlite.query("SELECT COUNT(*) AS n FROM dm_messages").get() as {
        n: number;
      };
      expect(n.n).toBe(1);
    });

    test(`WS subscribe and typing: a ${where} non-participant`, async () => {
      const { fed, dmId } = await setup();
      const carol = await registerOn(where === "local" ? fed.b : fed.a, "carol");
      const conn = await ws(fed.b, carol);
      const answer = async (target: string, type: string, data: unknown) => {
        conn.send({ id: "cmd", type, data });
        const err = await conn.ofType("error");
        return JSON.stringify({ correlationId: err.correlationId, data: err.data }).replaceAll(
          target,
          "<id>",
        );
      };
      const subKnown = await answer(dmId, "subscribe", { channels: [dmId] });
      expect(subKnown).toContain('"code":"not_found"');
      expect(subKnown).toBe(await answer(UNKNOWN, "subscribe", { channels: [UNKNOWN] }));
      const typKnown = await answer(dmId, "typing.start", { dmId });
      expect(typKnown).toBe(await answer(UNKNOWN, "typing.start", { dmId: UNKNOWN }));
    });
  }
});
