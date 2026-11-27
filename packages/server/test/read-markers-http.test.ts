/**
 * `GET`/`PATCH /api/me/read-markers` over the real signed HTTP surface (§7.7):
 *
 *  - the request is exactly `{ markers: [{ scopeId, lastReadMessageId }] }`; the
 *    old Forumall `lastReadSeq` forms, an empty list and a non-LocalId are `400`;
 *  - entries carry only spec fields (`scopeId`, `lastReadMessageId?`,
 *    `unreadCount`, `groupId?`), never a provider-internal seq;
 *  - markers only move forward (backward and equal ids are ignored);
 *  - a marker naming a message the provider does not hold in that scope, or an
 *    unknown / unreadable / unlisted scope, is ignored like an unknown scope:
 *    `200`, not stored, not reported, no `read.updated`;
 *  - `read.updated` carries the same entries as the PATCH response.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveDmId } from "@forumall/shared";

import { getReadMarkers } from "../src/provider/read-markers.ts";
import {
  type Booted,
  boot,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
} from "./helpers/provider-harness.ts";
import {
  dmTo,
  getMarkers,
  markRead,
  markerFor,
  patchMarkers,
  post,
  seedGroupChannel,
} from "./helpers/read-markers-fixtures.ts";

let tmp: string;
const booted: Booted[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-readmarkers-http-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

function start(name: string): Booted {
  const b = boot(tmp, name);
  booted.push(b);
  return b;
}

/** A booted provider with alice + bob sharing a private channel. */
async function fixture(name: string) {
  const b = start(name);
  const alice = await registerUserWithKey(b, "alice");
  const bob = await registerUserWithKey(b, "bob");
  const { groupId, channelId } = seedGroupChannel(b, alice, [bob]);
  return { b, alice, bob, groupId, channelId };
}

describe("GET /api/me/read-markers", () => {
  test("lists channel + DM scopes with only the spec fields", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-get");
    post(b, groupId, channelId, bob, "hey");
    const dmId = deriveDmId(alice.actor, bob.actor);
    dmTo(b, dmId, alice, bob, "dm");

    const scopes = await getMarkers(b, alice);
    // Nothing read yet: no `lastReadMessageId`; `groupId` only on the channel.
    expect(scopes.find((s) => s.scopeId === channelId)).toEqual({
      scopeId: channelId,
      unreadCount: 1,
      groupId,
    });
    expect(scopes.find((s) => s.scopeId === dmId)).toEqual({ scopeId: dmId, unreadCount: 1 });
  });

  test("unreadCount is exact past any badge cap and counts a tombstone deleted over REST", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-get-exact-tombstone");
    const read = post(b, groupId, channelId, bob, "read");
    await markRead(b, alice, [{ scopeId: channelId, lastReadMessageId: read.id }]);
    const UNREAD = 1001;
    // One transaction: a thousand separate commits are slow on a loaded disk.
    const posted = b.db.sqlite.transaction(() =>
      Array.from({ length: UNREAD }, (_, i) => post(b, groupId, channelId, bob, `m${i}`)),
    )();

    // Bob deletes one of his unread messages: it stays a tombstone at its
    // timeline position (§7.1), so the count does not drop (§7.7).
    const doomed = posted[500];
    if (!doomed) throw new Error("fixture posted too few messages");
    const del = await signedReq(
      b,
      bob,
      "DELETE",
      `/api/groups/${groupId}/channels/${channelId}/messages/${doomed.id}`,
    );
    expect(del.status).toBe(204);

    expect(await markerFor(b, alice, channelId)).toEqual({
      scopeId: channelId,
      lastReadMessageId: read.id,
      unreadCount: UNREAD,
      groupId,
    });
  });
});

describe("PATCH /api/me/read-markers — request shape", () => {
  test("the spec body advances the marker and reports it by message id", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-spec-body");
    const m1 = post(b, groupId, channelId, bob, "a");
    post(b, groupId, channelId, bob, "b");

    const scopes = await markRead(b, alice, [{ scopeId: channelId, lastReadMessageId: m1.id }]);
    const expected = { scopeId: channelId, lastReadMessageId: m1.id, unreadCount: 1, groupId };
    expect(scopes).toEqual([expected]);
    expect(await markerFor(b, alice, channelId)).toEqual(expected);
  });

  test("the old Forumall seq forms and malformed bodies are 400, and store nothing", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-old-body");
    const m1 = post(b, groupId, channelId, bob, "a");
    const bodies: unknown[] = [
      // What the web client used to send.
      { scopeId: channelId, lastReadSeq: m1.seq },
      // The seq extension inside the spec envelope.
      { markers: [{ scopeId: channelId, lastReadSeq: m1.seq }] },
      // No markers at all.
      { markers: [] },
      // Not a LocalId.
      { markers: [{ scopeId: channelId, lastReadMessageId: "not/a local id" }] },
      // Missing scope.
      { markers: [{ lastReadMessageId: m1.id }] },
    ];
    for (const body of bodies) {
      const res = await patchMarkers(b, alice, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
    }
    expect(getReadMarkers(b.db, "alice").size).toBe(0);
  });

  test("extra fields on the body and on a marker are tolerated (§2.3)", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-extra");
    const m1 = post(b, groupId, channelId, bob, "a");
    const res = await patchMarkers(b, alice, {
      markers: [{ scopeId: channelId, lastReadMessageId: m1.id, future: 1 }],
      extra: true,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scopes: unknown[] }).scopes.length).toBe(1);
  });
});

describe("PATCH /api/me/read-markers — monotonic", () => {
  test("a backward or equal marker is ignored; the stored marker stays", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-monotonic-http");
    const m1 = post(b, groupId, channelId, bob, "a");
    const m2 = post(b, groupId, channelId, bob, "b");
    post(b, groupId, channelId, bob, "c");

    expect(await markRead(b, alice, [{ scopeId: channelId, lastReadMessageId: m2.id }])).toEqual([
      { scopeId: channelId, lastReadMessageId: m2.id, unreadCount: 1, groupId },
    ]);
    expect(await markRead(b, alice, [{ scopeId: channelId, lastReadMessageId: m1.id }])).toEqual(
      [],
    );
    expect(await markRead(b, alice, [{ scopeId: channelId, lastReadMessageId: m2.id }])).toEqual(
      [],
    );
    expect(await markerFor(b, alice, channelId)).toEqual({
      scopeId: channelId,
      lastReadMessageId: m2.id,
      unreadCount: 1,
      groupId,
    });
  });

  test("several markers for one scope: applied in order, reported once at the final position", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-dup-scope");
    const m1 = post(b, groupId, channelId, bob, "a");
    const m2 = post(b, groupId, channelId, bob, "b");
    const m3 = post(b, groupId, channelId, bob, "c");

    // Newest first: the second (older) marker is ignored.
    expect(
      await markRead(b, alice, [
        { scopeId: channelId, lastReadMessageId: m2.id },
        { scopeId: channelId, lastReadMessageId: m1.id },
      ]),
    ).toEqual([{ scopeId: channelId, lastReadMessageId: m2.id, unreadCount: 1, groupId }]);
    // Both forward: one entry, at the newer one.
    await markRead(b, alice, [{ scopeId: channelId, lastReadMessageId: m2.id }]);
    const bob2 = post(b, groupId, channelId, bob, "d");
    expect(
      await markRead(b, alice, [
        { scopeId: channelId, lastReadMessageId: m3.id },
        { scopeId: channelId, lastReadMessageId: bob2.id },
      ]),
    ).toEqual([{ scopeId: channelId, lastReadMessageId: bob2.id, unreadCount: 0, groupId }]);
  });
});

describe("PATCH /api/me/read-markers — unknown ids and scopes", () => {
  test("an unknown message id, a message from another scope, or an unknown scope is ignored", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-unknown");
    const m1 = post(b, groupId, channelId, bob, "a");
    post(b, groupId, channelId, bob, "b");
    // A second channel alice can read: its message is not "in" the first scope.
    const other = seedGroupChannel(b, alice, [bob]);
    const elsewhere = post(b, other.groupId, other.channelId, bob, "elsewhere");

    const device2 = await connectAuthenticated(b, alice);
    const scopes = await markRead(b, alice, [
      { scopeId: channelId, lastReadMessageId: "msg_nope" },
      { scopeId: channelId, lastReadMessageId: elsewhere.id },
      { scopeId: "chn_unknown", lastReadMessageId: m1.id },
      { scopeId: "dm_unknown", lastReadMessageId: m1.id },
    ]);
    expect(scopes).toEqual([]);
    expect(getReadMarkers(b.db, "alice").size).toBe(0);

    // Ignored markers emit no read.updated: the first event device2 sees is for
    // the valid marker sent next, mixed in with an ignored one.
    const next = await markRead(b, alice, [
      { scopeId: channelId, lastReadMessageId: "msg_nope" },
      { scopeId: channelId, lastReadMessageId: m1.id },
    ]);
    expect(next).toEqual([
      { scopeId: channelId, lastReadMessageId: m1.id, unreadCount: 1, groupId },
    ]);
    const evt = await device2.ofType("read.updated");
    expect((evt.data as { markers: unknown }).markers).toEqual(next);
    device2.close();
  });

  test("a DM marker may name the caller's own sent message held on this provider", async () => {
    const b = start("rm-dm-sent");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    dmTo(b, dmId, alice, bob, "to alice");
    // alice's reply lives in bob's inbox on the same provider (no sender copy).
    const sent = dmTo(b, dmId, bob, alice, "to bob");
    dmTo(b, dmId, alice, bob, "to alice again");

    expect(await markRead(b, alice, [{ scopeId: dmId, lastReadMessageId: sent.id }])).toEqual([
      { scopeId: dmId, lastReadMessageId: sent.id, unreadCount: 1 },
    ]);
  });

  test("scopes the caller can't read are ignored (no existence/activity oracle)", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-unreadable");
    const eve = await registerUserWithKey(b, "eve");
    const m1 = post(b, groupId, channelId, bob, "secret");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const dm = dmTo(b, dmId, alice, bob, "private dm");

    const scopes = await markRead(b, eve, [
      { scopeId: channelId, lastReadMessageId: m1.id },
      { scopeId: dmId, lastReadMessageId: dm.id },
    ]);
    expect(scopes).toEqual([]);
    expect(getReadMarkers(b.db, "eve").size).toBe(0);

    // Control: the same markers from a reader advance.
    const ok = await markRead(b, alice, [
      { scopeId: channelId, lastReadMessageId: m1.id },
      { scopeId: dmId, lastReadMessageId: dm.id },
    ]);
    expect(ok.map((s) => s.scopeId).sort()).toEqual([channelId, dmId].sort());
  });

  test("a readable public channel in a group the caller hasn't joined is ignored", async () => {
    // §7.7: only a scope GET would list — a readable channel IN A GROUP THE
    // USER BELONGS TO. A non-member's GET never lists a public channel.
    const b = start("rm-public-nonmember");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const { groupId, channelId } = seedGroupChannel(b, alice, [bob], "public");
    const m1 = post(b, groupId, channelId, alice, "hello world");

    expect(await markRead(b, carol, [{ scopeId: channelId, lastReadMessageId: m1.id }])).toEqual(
      [],
    );
    expect(getReadMarkers(b.db, "carol").has(channelId)).toBe(false);
    expect(await markerFor(b, carol, channelId)).toBeUndefined();

    // Control: a member's marker on the same channel advances.
    expect(await markRead(b, bob, [{ scopeId: channelId, lastReadMessageId: m1.id }])).toEqual([
      { scopeId: channelId, lastReadMessageId: m1.id, unreadCount: 0, groupId },
    ]);
  });
});

describe("read.updated", () => {
  test("carries exactly the PATCH response's entries to the caller's other device", async () => {
    const { b, alice, bob, groupId, channelId } = await fixture("rm-fanout");
    post(b, groupId, channelId, bob, "x");
    const m2 = post(b, groupId, channelId, bob, "y");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const dm = dmTo(b, dmId, alice, bob, "dm");

    const device2 = await connectAuthenticated(b, alice);
    const scopes = await markRead(b, alice, [
      { scopeId: channelId, lastReadMessageId: m2.id },
      { scopeId: dmId, lastReadMessageId: dm.id },
    ]);
    expect(scopes).toEqual([
      { scopeId: channelId, lastReadMessageId: m2.id, unreadCount: 0, groupId },
      { scopeId: dmId, lastReadMessageId: dm.id, unreadCount: 0 },
    ]);
    const evt = await device2.ofType("read.updated");
    expect((evt.data as { markers: unknown }).markers).toEqual(scopes);
    device2.close();
  });
});
