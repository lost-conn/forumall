/**
 * Membership rules (spec §5.7) not covered by `membership.test.ts`,
 * `membership-requests.test.ts` or `display-name.test.ts`:
 *  - a repeat `join` under `request` answers `202` with the pending request
 *    unchanged (a new `message` does not replace it), recording nothing new;
 *  - `leave` from a non-member → `404`;
 *  - the role-change subset rule binds the member's CURRENT role, not only the
 *    requested one;
 *  - join-request approve/deny are gated on `manage` OR `moderate` without the
 *    subset rule, and approving someone already a member answers `200` with
 *    the existing `Member` and marks the request `approved`;
 *  - nickname validation: trimmed, at most 64 characters (`400`), blank or
 *    `null` clears, and `404` for no such group or member.
 */
import { describe, expect, test } from "bun:test";
import type { JoinRequest, Member } from "@forumall/shared";
import { eq } from "drizzle-orm";

import { joinRequests } from "../src/db/schema.ts";
import { getJoinRequestRow } from "../src/provider/membership.ts";
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

const freshApp = useMembershipApp("membership-rules");

async function requestJoin(app: App, signer: Signer, groupId: string, body?: unknown) {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/join`, body);
  expect(res.status).toBe(202);
  return (await res.json()) as JoinRequest;
}

async function listRequests(app: App, signer: Signer, groupId: string) {
  const res = await signedRequest(app, signer, "GET", `/api/groups/${groupId}/requests`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: JoinRequest[] }).items;
}

async function listMembers(app: App, signer: Signer, groupId: string) {
  const res = await signedRequest(app, signer, "GET", `/api/groups/${groupId}/members`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Member[] }).items;
}

describe("repeat join and leave (§5.7)", () => {
  test("a repeat join with a different message → 202 with the pending request unchanged", async () => {
    const { app, db } = freshApp("repeat-join");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "R",
      tier: "public",
      joinPolicy: "request",
    });

    const first = await requestJoin(app, bob, group.id, { message: "first" });
    const again = await requestJoin(app, bob, group.id, { message: "second" });
    expect(again).toEqual(first);
    expect(again.message).toBe("first");

    // Nothing new recorded: one row, still the original message.
    const rows = db.drizzle
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.groupId, group.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(await listRequests(app, alice, group.id)).toEqual([first]);
  });

  test("leave from a signed non-member → 404; from an unknown group → 404", async () => {
    const { app } = freshApp("leave-nonmember");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });

    const res = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/leave`);
    expect(res.status).toBe(404);
    const unknown = await signedRequest(app, bob, "POST", "/api/groups/grp_nosuchgroup/leave");
    expect(unknown.status).toBe(404);
    expect((await listMembers(app, alice, group.id)).map((m) => m.user)).toEqual([alice.actor]);
  });
});

describe("role change: the subset rule binds the member's current role (§5.7)", () => {
  test("a manager may not demote a member holding a permission the manager lacks", async () => {
    const { app, db } = freshApp("subset-current");
    const owner = await registerUserWithKey(app, "owner");
    const mgr = await registerUserWithKey(app, "mgr");
    const mod = await registerUserWithKey(app, "mod");
    const plain = await registerUserWithKey(app, "plain");
    // `steward` holds `manage` (and posting) but not `moderate`; `warden` holds
    // `moderate` and posting. `member` holds only posting.
    const group = await createGroup(app, owner, {
      name: "G",
      tier: "public",
      permissions: {
        post: ["steward", "warden", "member"],
        manage: ["steward"],
        moderate: ["warden"],
      },
      roles: [{ name: "steward" }, { name: "warden" }, { name: "member" }],
    });
    seedMember(db, group.id, mgr.actor, "steward");
    seedMember(db, group.id, mod.actor, "warden");
    seedMember(db, group.id, plain.actor, "member");

    // The requested role (`member`) is within the steward's powers, but the
    // warden's current role holds `moderate`, which the steward lacks → 403.
    const demote = await signedRequest(
      app,
      mgr,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(mod.actor)}`,
      { role: "member" },
    );
    expect(demote.status).toBe(403);

    // Control: a target whose current role is within the steward's powers.
    const promote = await signedRequest(
      app,
      mgr,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(plain.actor)}`,
      { role: "steward" },
    );
    expect(promote.status).toBe(200);

    const roles = new Map((await listMembers(app, owner, group.id)).map((m) => [m.user, m.role]));
    expect(roles.get(mod.actor)).toBe("warden");
    expect(roles.get(plain.actor)).toBe("steward");
  });
});

describe("join-request approve/deny gating (§5.7)", () => {
  /** A `request` group whose `warden` role holds ONLY `moderate`. */
  async function moderatedGroup(name: string) {
    const { app, db } = freshApp(name);
    const owner = await registerUserWithKey(app, "owner");
    const warden = await registerUserWithKey(app, "warden");
    const plain = await registerUserWithKey(app, "plain");
    const group = await createGroup(app, owner, {
      name: "G",
      tier: "public",
      joinPolicy: "request",
      permissions: { post: ["admin", "member"], manage: ["admin"], moderate: ["warden"] },
      roles: [{ name: "admin" }, { name: "member" }, { name: "warden" }],
    });
    seedMember(db, group.id, warden.actor, "warden");
    seedMember(db, group.id, plain.actor, "member");
    return { app, db, owner, warden, plain, group };
  }

  test("a moderate-only role approves (the requester gets `member`, which holds a permission the approver lacks: no subset rule) and denies", async () => {
    const { app, owner, warden, group } = await moderatedGroup("approve-moderate");
    const carol = await registerUserWithKey(app, "carol");
    const dave = await registerUserWithKey(app, "dave");
    const carolReq = await requestJoin(app, carol, group.id);
    const daveReq = await requestJoin(app, dave, group.id);

    const approve = await signedRequest(
      app,
      warden,
      "POST",
      `/api/groups/${group.id}/requests/${carolReq.id}/approve`,
    );
    expect(approve.status).toBe(200);
    const member = (await approve.json()) as Member;
    expect(member.user).toBe(carol.actor);
    expect(member.role).toBe("member");

    const deny = await signedRequest(
      app,
      warden,
      "POST",
      `/api/groups/${group.id}/requests/${daveReq.id}/deny`,
    );
    expect(deny.status).toBe(204);

    expect(await listRequests(app, owner, group.id)).toEqual([]);
    const users = (await listMembers(app, owner, group.id)).map((m) => m.user);
    expect(users).toContain(carol.actor);
    expect(users).not.toContain(dave.actor);
  });

  test("a caller holding neither manage nor moderate → 403 on approve and deny; the request stays pending", async () => {
    const { app, owner, plain, group } = await moderatedGroup("approve-forbidden");
    const carol = await registerUserWithKey(app, "carol");
    const req = await requestJoin(app, carol, group.id);

    for (const action of ["approve", "deny"]) {
      const res = await signedRequest(
        app,
        plain,
        "POST",
        `/api/groups/${group.id}/requests/${req.id}/${action}`,
      );
      expect(res.status).toBe(403);
    }
    expect(await listRequests(app, owner, group.id)).toEqual([req]);
  });

  test("approving a requester who is already a member → 200 with the existing Member, unchanged; the request is marked approved", async () => {
    const { app, db, owner, group } = await moderatedGroup("approve-member");
    const carol = await registerUserWithKey(app, "carol");
    const req = await requestJoin(app, carol, group.id);
    // carol became a member another way (e.g. an invite) while pending.
    seedMember(db, group.id, carol.actor, "admin", Date.parse("2026-04-05T06:07:08Z"));
    const existing = { user: carol.actor, role: "admin", joinedAt: "2026-04-05T06:07:08Z" };

    const approve = await signedRequest(
      app,
      owner,
      "POST",
      `/api/groups/${group.id}/requests/${req.id}/approve`,
    );
    expect(approve.status).toBe(200);
    expect(await approve.json()).toEqual(existing);
    expect(getJoinRequestRow(db, req.id)?.state).toBe("approved");
    expect((await listMembers(app, owner, group.id)).find((m) => m.user === carol.actor)).toEqual(
      existing,
    );
  });
});

describe("nickname validation (§5.7 display-name)", () => {
  async function nicknameGroup(name: string) {
    const { app, db } = freshApp(name);
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const path = `/api/groups/${group.id}/members/${ref(alice.actor)}/display-name`;
    const set = (body: unknown) => signedRequest(app, alice, "PATCH", path, body);
    return { app, db, alice, group, set };
  }

  test("the value is trimmed and at most 64 characters, counted in code points; longer → 400", async () => {
    const { app, alice, group, set } = await nicknameGroup("nick-length");

    const trimmed = await set({ displayNameOverride: "  Ada (mod)  " });
    expect(trimmed.status).toBe(200);
    expect(((await trimmed.json()) as Member).displayNameOverride).toBe("Ada (mod)");

    const max = "x".repeat(64);
    expect(
      ((await (await set({ displayNameOverride: max })).json()) as Member).displayNameOverride,
    ).toBe(max);
    // Surrounding whitespace does not count against the limit.
    expect((await set({ displayNameOverride: `  ${max}  ` })).status).toBe(200);
    expect((await set({ displayNameOverride: "x".repeat(65) })).status).toBe(400);

    // 64 emoji are 64 characters (128 UTF-16 code units).
    const emoji = "😀".repeat(64);
    const astral = await set({ displayNameOverride: emoji });
    expect(astral.status).toBe(200);
    expect(((await astral.json()) as Member).displayNameOverride).toBe(emoji);
    expect((await set({ displayNameOverride: "😀".repeat(65) })).status).toBe(400);

    // A rejected value leaves the stored one in place.
    const [stored] = await listMembers(app, alice, group.id);
    expect(stored?.displayNameOverride).toBe(emoji);
  });

  test("null, an empty string or only whitespace clears it; a non-string → 400", async () => {
    const { set } = await nicknameGroup("nick-clear");
    for (const clear of [null, "", "   \t "]) {
      expect((await set({ displayNameOverride: "Nick" })).status).toBe(200);
      const res = await set({ displayNameOverride: clear });
      expect(res.status).toBe(200);
      expect((await res.json()) as Member).not.toHaveProperty("displayNameOverride");
    }
    expect((await set({ displayNameOverride: 42 })).status).toBe(400);
  });

  test("no such group or member → 404", async () => {
    const { app, alice, group } = await nicknameGroup("nick-404");
    const body = { displayNameOverride: "Nick" };

    const noGroup = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/grp_nosuchgroup/members/${ref(alice.actor)}/display-name`,
      body,
    );
    expect(noGroup.status).toBe(404);

    const noMember = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/members/${ref("ghost@providera.test")}/display-name`,
      body,
    );
    expect(noMember.status).toBe(404);

    // A non-member naming themselves is "no such member" too.
    const bob = await registerUserWithKey(app, "bob");
    const self = await signedRequest(
      app,
      bob,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(bob.actor)}/display-name`,
      body,
    );
    expect(self.status).toBe(404);
  });
});
