/**
 * `GET /api/groups/{groupId}/members` invariants (spec §5.7):
 *  - the owner is listed as a member with role `owner`;
 *  - a member's `joinedAt` is when they became a member — the group's
 *    `createdAt` for the creator — and a role change, an ownership transfer
 *    included, leaves it unchanged for both members;
 *  - the order is stable, so paging with §7.2 cursors neither skips nor repeats
 *    a member who stays in the group throughout, while others join, leave or
 *    change role between pages.
 */
import { describe, expect, test } from "bun:test";
import type { Member } from "@forumall/shared";

import { at } from "./helpers/at.ts";
import {
  type App,
  type Signer,
  createGroup,
  ref,
  registerUserWithKey,
  seedMember,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("membership-listing");

interface MemberPage {
  items: Member[];
  page: { nextCursor: string | null };
}

async function listPage(
  app: App,
  viewer: Signer,
  groupId: string,
  query: string,
): Promise<MemberPage> {
  const res = await signedRequest(app, viewer, "GET", `/api/groups/${groupId}/members?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as MemberPage;
}

async function listAll(app: App, viewer: Signer, groupId: string): Promise<Member[]> {
  return (await listPage(app, viewer, groupId, "limit=100")).items;
}

function find(members: readonly Member[], user: string): Member {
  const m = members.find((x) => x.user === user);
  if (!m) throw new Error(`${user} not listed`);
  return m;
}

async function changeRole(app: App, caller: Signer, groupId: string, user: string, role: string) {
  const res = await signedRequest(
    app,
    caller,
    "PATCH",
    `/api/groups/${groupId}/members/${ref(user)}`,
    {
      role,
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Member;
}

describe("the owner and joinedAt (§5.7)", () => {
  test("the creator is listed with role `owner` and joinedAt = the group's createdAt", async () => {
    const { app } = freshApp("owner-listed");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });

    const members = await listAll(app, alice, group.id);
    expect(members).toEqual([{ user: alice.actor, role: "owner", joinedAt: group.createdAt }]);
  });

  test("a role change leaves joinedAt unchanged", async () => {
    const { app, db } = freshApp("joined-role");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, bob.actor, "member", Date.parse("2026-01-02T03:04:05Z"));

    const before = find(await listAll(app, alice, group.id), bob.actor).joinedAt;
    expect(before).toBe("2026-01-02T03:04:05Z");

    expect((await changeRole(app, alice, group.id, bob.actor, "admin")).joinedAt).toBe(before);
    expect((await changeRole(app, alice, group.id, bob.actor, "member")).joinedAt).toBe(before);
    expect(find(await listAll(app, alice, group.id), bob.actor)).toEqual({
      user: bob.actor,
      role: "member",
      joinedAt: before,
    });
  });

  test("an ownership transfer leaves joinedAt unchanged for both members", async () => {
    const { app, db } = freshApp("joined-transfer");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, bob.actor, "member", Date.parse("2026-02-03T04:05:06Z"));

    const transferred = await changeRole(app, alice, group.id, bob.actor, "owner");
    expect(transferred).toEqual({
      user: bob.actor,
      role: "owner",
      joinedAt: "2026-02-03T04:05:06Z",
    });

    const members = await listAll(app, bob, group.id);
    expect(find(members, alice.actor)).toEqual({
      user: alice.actor,
      role: "admin",
      joinedAt: group.createdAt,
    });
    expect(find(members, bob.actor)).toEqual(transferred);
  });
});

describe("stable member order for cursor paging (§5.7, §7.2)", () => {
  test("members who stay are listed exactly once while others join, leave and change role between pages", async () => {
    const { app, db } = freshApp("stable-order");
    const owner = await registerUserWithKey(app, "owner");
    const group = await createGroup(app, owner, { name: "G", tier: "public" });

    // Seeded members, two of them with the SAME joinedAt (a tie the order
    // must still break deterministically).
    const t0 = Date.parse("2026-03-01T00:00:00Z");
    const seeded = ["mem1", "mem2", "mem3", "mem4", "mem5", "mem6"].map(
      (h) => `${h}@providera.test`,
    );
    seeded.forEach((user, i) => {
      seedMember(db, group.id, user, "member", i === 2 ? t0 + 1000 : t0 + i * 1000);
    });
    const leaver = await registerUserWithKey(app, "leaver");
    seedMember(db, group.id, leaver.actor, "member", t0 + 2500);

    // Page 1, then churn, then the remaining pages.
    const first = await listPage(app, owner, group.id, "limit=3");
    expect(first.items).toHaveLength(3);
    const listed = first.items.map((m) => m.user);
    let cursor = first.page.nextCursor;
    expect(cursor).not.toBeNull();

    // A newcomer joins (open policy is not needed: seed it directly, as join
    // would, with the current time).
    seedMember(db, group.id, "newcomer@providera.test", "member");
    // A member not yet listed leaves.
    const leave = await signedRequest(app, leaver, "POST", `/api/groups/${group.id}/leave`);
    expect(leave.status).toBe(204);
    // A member not yet listed is promoted; one already listed is too.
    await changeRole(app, owner, group.id, "mem5@providera.test", "admin");
    await changeRole(app, owner, group.id, at(listed, 1), "admin");

    while (cursor !== null) {
      const page = await listPage(
        app,
        owner,
        group.id,
        `limit=3&cursor=${encodeURIComponent(cursor)}`,
      );
      listed.push(...page.items.map((m) => m.user));
      cursor = page.page.nextCursor;
    }

    // Everyone who stayed throughout appears exactly once.
    for (const user of [owner.actor, ...seeded]) {
      expect(listed.filter((u) => u === user)).toHaveLength(1);
    }
    expect(new Set(listed).size).toBe(listed.length);

    // And the same walk on the settled group yields the one-shot listing's order.
    const settled: string[] = [];
    let c: string | null = null;
    do {
      const q: string = c === null ? "limit=2" : `limit=2&cursor=${encodeURIComponent(c)}`;
      const page = await listPage(app, owner, group.id, q);
      settled.push(...page.items.map((m) => m.user));
      c = page.page.nextCursor;
    } while (c !== null);
    expect(settled).toEqual((await listAll(app, owner, group.id)).map((m) => m.user));
  });

  test("a malformed or forged cursor is treated as the first page, never a 500", async () => {
    const { app, db } = freshApp("bad-cursor");
    const owner = await registerUserWithKey(app, "owner");
    const group = await createGroup(app, owner, { name: "G", tier: "public" });
    seedMember(db, group.id, "member1@providera.test", "member");
    const firstPage = await listPage(app, owner, group.id, "limit=1");

    const b64 = (json: string) => Buffer.from(json).toString("base64url");
    for (const cursor of [
      "!!!",
      b64("5"),
      b64("null"),
      b64('{"joinedAt":"x","user":"a"}'),
      b64('{"joinedAt":1}'),
      b64('{"user":"a@b.test"}'),
    ]) {
      const query = `limit=1&cursor=${encodeURIComponent(cursor)}`;
      expect(await listPage(app, owner, group.id, query)).toEqual(firstPage);
    }
  });
});
