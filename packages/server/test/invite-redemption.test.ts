/**
 * Invite redemption rules (spec §5.6, §4.8): `redeem` checks the invite before
 * the caller's membership; an existing member's redeem answers `200` with the
 * current role and consumes no use; a since-deleted `channelId` is omitted;
 * a guest provisioned through `/guest` always gets role `guest`, and a deleted
 * channel does not block it. Shared setup is `helpers/membership-app.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  type Channel,
  type InviteCreateResponse,
  InviteCreateResponseSchema,
  generateKeyPair,
} from "@forumall/shared";
import { eq } from "drizzle-orm";

import { groupMembers, invites } from "../src/db/schema.ts";
import {
  type App,
  type MembershipApp,
  type Signer,
  createGroup,
  registerUserWithKey,
  seedMember,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("invite-redemption");

async function createInvite(
  app: App,
  signer: Signer,
  groupId: string,
  body: Record<string, unknown> = {},
): Promise<InviteCreateResponse> {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/invites`, body);
  expect(res.status).toBe(201);
  return InviteCreateResponseSchema.parse(await res.json());
}

async function createChannel(app: App, signer: Signer, groupId: string): Promise<Channel> {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/channels`, {
    name: "general",
    type: "text",
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Channel;
}

function redeem(app: App, signer: Signer, token: string) {
  return signedRequest(app, signer, "POST", `/api/invites/${token}/redeem`);
}

function usesOf({ db }: MembershipApp, inviteId: string): number | undefined {
  return db.drizzle.select().from(invites).where(eq(invites.id, inviteId)).all()[0]?.uses;
}

function roleOf({ db }: MembershipApp, groupId: string, actor: string): string | undefined {
  return db.drizzle
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.user, actor))
    .all()
    .find((m) => m.groupId === groupId)?.role;
}

/** Provision a guest through `/guest` (unsigned) with a fresh device key. */
function provisionGuest(app: App, token: string) {
  const { publicKey } = generateKeyPair();
  return app.request(`/api/invites/${token}/guest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Guest",
      public_key: publicKey,
      algorithm: "Ed25519",
      device_name: "test device",
    }),
  });
}

describe("redeem checks the invite first (§5.6)", () => {
  test("an exhausted invite → 409 even for an existing member or the owner", async () => {
    const b = freshApp("exhausted-member");
    const alice = await registerUserWithKey(b.app, "alice");
    const bob = await registerUserWithKey(b.app, "bob");
    const carol = await registerUserWithKey(b.app, "carol");
    const group = await createGroup(b.app, alice, { name: "G" });
    const invite = await createInvite(b.app, alice, group.id, { maxUses: 1 });

    expect((await redeem(b.app, bob, invite.token)).status).toBe(200);
    seedMember(b.db, group.id, carol.actor, "member");

    expect((await redeem(b.app, bob, invite.token)).status).toBe(409);
    expect((await redeem(b.app, carol, invite.token)).status).toBe(409);
    expect((await redeem(b.app, alice, invite.token)).status).toBe(409);
    expect(usesOf(b, invite.id)).toBe(1);
  });

  test("an unknown or expired token → 404 even for an existing member", async () => {
    const b = freshApp("unknown-member");
    const alice = await registerUserWithKey(b.app, "alice");
    const group = await createGroup(b.app, alice, { name: "G" });
    const past = new Date(Date.now() - 60_000).toISOString();
    const expired = await createInvite(b.app, alice, group.id, { expiresAt: past });

    expect((await redeem(b.app, alice, "no-such-token")).status).toBe(404);
    expect((await redeem(b.app, alice, expired.token)).status).toBe(404);
  });
});

describe("a member's redeem (§5.6)", () => {
  test("→ 200 with the invite's channelId and the CURRENT role; no use consumed", async () => {
    const b = freshApp("member-redeem");
    const alice = await registerUserWithKey(b.app, "alice");
    const bob = await registerUserWithKey(b.app, "bob");
    const group = await createGroup(b.app, alice, { name: "G" });
    const channel = await createChannel(b.app, alice, group.id);
    seedMember(b.db, group.id, bob.actor, "admin");
    const invite = await createInvite(b.app, alice, group.id, {
      role: "guest",
      channelId: channel.id,
      maxUses: 1,
    });

    const res = await redeem(b.app, bob, invite.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groupId: group.id, channelId: channel.id, role: "admin" });
    expect(roleOf(b, group.id, bob.actor)).toBe("admin");
    expect(usesOf(b, invite.id)).toBe(0);

    // The owner is answered the same way.
    const owner = await redeem(b.app, alice, invite.token);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ groupId: group.id, channelId: channel.id, role: "owner" });
    expect(usesOf(b, invite.id)).toBe(0);
  });
});

describe("an invite naming a since-deleted channel (§5.6)", () => {
  test("redeem succeeds and omits `channelId`, for a non-member and a member", async () => {
    const b = freshApp("deleted-channel");
    const alice = await registerUserWithKey(b.app, "alice");
    const bob = await registerUserWithKey(b.app, "bob");
    const group = await createGroup(b.app, alice, { name: "G" });
    const channel = await createChannel(b.app, alice, group.id);
    const invite = await createInvite(b.app, alice, group.id, { channelId: channel.id });
    const del = await signedRequest(
      b.app,
      alice,
      "DELETE",
      `/api/groups/${group.id}/channels/${channel.id}`,
    );
    expect(del.status).toBe(204);

    const joined = await redeem(b.app, bob, invite.token);
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual({ groupId: group.id, role: "member" });
    expect(roleOf(b, group.id, bob.actor)).toBe("member");

    const again = await redeem(b.app, bob, invite.token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ groupId: group.id, role: "member" });
    expect(usesOf(b, invite.id)).toBe(1);
  });

  test("/guest still joins the guest to the group", async () => {
    const b = freshApp("deleted-channel-guest");
    const alice = await registerUserWithKey(b.app, "alice");
    const group = await createGroup(b.app, alice, { name: "G" });
    const channel = await createChannel(b.app, alice, group.id);
    const invite = await createInvite(b.app, alice, group.id, {
      channelId: channel.id,
      grantsGuest: true,
    });
    await signedRequest(b.app, alice, "DELETE", `/api/groups/${group.id}/channels/${channel.id}`);

    const res = await provisionGuest(b.app, invite.token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { actor: string; groupId: string; role: string };
    expect(body.groupId).toBe(group.id);
    expect(roleOf(b, group.id, body.actor)).toBe("guest");
  });
});

describe("/guest always grants role `guest` (§4.8, §5.6)", () => {
  test("whatever the invite's role", async () => {
    const b = freshApp("guest-role");
    const alice = await registerUserWithKey(b.app, "alice");
    const group = await createGroup(b.app, alice, {
      name: "G",
      roles: [{ name: "admin" }, { name: "member" }, { name: "guest" }, { name: "helper" }],
    });

    for (const role of ["admin", "member", "helper", undefined]) {
      const invite = await createInvite(b.app, alice, group.id, {
        grantsGuest: true,
        ...(role !== undefined ? { role } : {}),
      });
      const res = await provisionGuest(b.app, invite.token);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { actor: string; role: string };
      expect({ role, granted: body.role }).toEqual({ role, granted: "guest" });
      expect(roleOf(b, group.id, body.actor)).toBe("guest");
    }
  });
});

describe("an invite whose custom role the group no longer defines (§5.6)", () => {
  // The spec defines no redeem-time answer, so the invite is refused with the
  // `400` an unknown role gets at creation; no use is consumed and nobody
  // joins with a role the group's catalogue no longer lists.
  test("redeem → 400 for a non-member, no use consumed; a member still gets 200", async () => {
    const b = freshApp("removed-role");
    const alice = await registerUserWithKey(b.app, "alice");
    const bob = await registerUserWithKey(b.app, "bob");
    const carol = await registerUserWithKey(b.app, "carol");
    const group = await createGroup(b.app, alice, { name: "G", roles: [{ name: "helper" }] });
    const invite = await createInvite(b.app, alice, group.id, { role: "helper" });
    seedMember(b.db, group.id, carol.actor, "member");

    const patch = await signedRequest(b.app, alice, "PATCH", `/api/groups/${group.id}`, {
      roles: [],
    });
    expect(patch.status).toBe(200);

    const res = await redeem(b.app, bob, invite.token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe("bad_request");
    expect(roleOf(b, group.id, bob.actor)).toBeUndefined();
    expect(usesOf(b, invite.id)).toBe(0);

    const member = await redeem(b.app, carol, invite.token);
    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({ groupId: group.id, role: "member" });
  });

  test("redeem succeeds again once the role is redefined", async () => {
    const b = freshApp("restored-role");
    const alice = await registerUserWithKey(b.app, "alice");
    const bob = await registerUserWithKey(b.app, "bob");
    const group = await createGroup(b.app, alice, { name: "G", roles: [{ name: "helper" }] });
    const invite = await createInvite(b.app, alice, group.id, { role: "helper" });
    const path = `/api/groups/${group.id}`;
    expect((await signedRequest(b.app, alice, "PATCH", path, { roles: [] })).status).toBe(200);
    const restore = { roles: [{ name: "helper" }] };
    expect((await signedRequest(b.app, alice, "PATCH", path, restore)).status).toBe(200);

    const res = await redeem(b.app, bob, invite.token);
    expect(res.status).toBe(200);
    expect(roleOf(b, group.id, bob.actor)).toBe("helper");
  });
});
