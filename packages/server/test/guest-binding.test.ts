/**
 * Guest binding (spec §4.8): a guest account is bound to the group it joined.
 * Every path that would make it a member (or owner) of another group answers
 * `403` `forbidden` and changes nothing: redeeming another group's invite
 * (§5.6 lists `403` for "provider/group policy forbids"), `POST …/join` under
 * the `open` and `request` policies, the channel-join alias (§8.2), and
 * creating a group. Its own group keeps the normal answers. Shared setup is
 * `helpers/membership-app.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type Channel, InviteCreateResponseSchema, generateKeyPair } from "@forumall/shared";
import { eq } from "drizzle-orm";

import { groupMembers, groups, invites, joinRequests } from "../src/db/schema.ts";
import {
  type App,
  type MembershipApp,
  type Signer,
  createGroup,
  registerUserWithKey,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("guest-binding");

async function createInviteToken(
  app: App,
  signer: Signer,
  groupId: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; token: string }> {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/invites`, body);
  expect(res.status).toBe(201);
  return InviteCreateResponseSchema.parse(await res.json());
}

/** Provision a guest through `/guest` and return it as a signer. */
async function provisionGuest(app: App, token: string): Promise<Signer> {
  const { publicKey, privateKey } = generateKeyPair();
  const res = await app.request(`/api/invites/${token}/guest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { actor: string; key_id: string };
  return { actor: body.actor, keyId: body.key_id, privateKey };
}

function groupsOf({ db }: MembershipApp, actor: string): string[] {
  return db.drizzle
    .select()
    .from(groupMembers)
    .where(eq(groupMembers.user, actor))
    .all()
    .map((m) => m.groupId);
}

async function expectForbidden(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(((await res.json()) as { errorCode: string }).errorCode).toBe("forbidden");
}

/** A guest of group G, plus a second group H run by the same owner. */
async function setup(b: MembershipApp, other: Record<string, unknown>) {
  const alice = await registerUserWithKey(b.app, "alice");
  const own = await createGroup(b.app, alice, { name: "Own" });
  const guest = await provisionGuest(
    b.app,
    (await createInviteToken(b.app, alice, own.id, { grantsGuest: true })).token,
  );
  const otherGroup = await createGroup(b.app, alice, { name: "Other", ...other });
  return { alice, own, guest, otherGroup };
}

describe("a guest is bound to the group it joined (§4.8)", () => {
  test("redeeming another group's invite → 403, no membership, no use consumed", async () => {
    const b = freshApp("redeem-other");
    const { alice, own, guest, otherGroup } = await setup(b, {});
    const invite = await createInviteToken(b.app, alice, otherGroup.id, { grantsGuest: true });

    await expectForbidden(
      await signedRequest(b.app, guest, "POST", `/api/invites/${invite.token}/redeem`),
    );
    expect(groupsOf(b, guest.actor)).toEqual([own.id]);
    const uses = b.db.drizzle.select().from(invites).where(eq(invites.id, invite.id)).all()[0];
    expect(uses?.uses).toBe(0);
  });

  test("its own group's invite still answers 200 with its current role", async () => {
    const b = freshApp("redeem-own");
    const { alice, own, guest } = await setup(b, {});
    const invite = await createInviteToken(b.app, alice, own.id);

    const res = await signedRequest(b.app, guest, "POST", `/api/invites/${invite.token}/redeem`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groupId: own.id, role: "guest" });
  });

  test("POST …/join of an open group → 403; of its own group → 200", async () => {
    const b = freshApp("join-open");
    const { own, guest, otherGroup } = await setup(b, { tier: "public", joinPolicy: "open" });

    await expectForbidden(
      await signedRequest(b.app, guest, "POST", `/api/groups/${otherGroup.id}/join`),
    );
    expect(groupsOf(b, guest.actor)).toEqual([own.id]);
    const ownJoin = await signedRequest(b.app, guest, "POST", `/api/groups/${own.id}/join`);
    expect(ownJoin.status).toBe(200);
  });

  test("POST …/join of a request group → 403 and no join request filed", async () => {
    const b = freshApp("join-request");
    const { guest, otherGroup } = await setup(b, { tier: "public", joinPolicy: "request" });

    await expectForbidden(
      await signedRequest(b.app, guest, "POST", `/api/groups/${otherGroup.id}/join`, {
        message: "let me in",
      }),
    );
    const requests = b.db.drizzle
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.user, guest.actor))
      .all();
    expect(requests).toEqual([]);
  });

  test("the channel-join alias of another group → 403", async () => {
    const b = freshApp("channel-join");
    const { alice, own, guest, otherGroup } = await setup(b, {
      tier: "public",
      joinPolicy: "open",
    });
    const chan = await signedRequest(
      b.app,
      alice,
      "POST",
      `/api/groups/${otherGroup.id}/channels`,
      {
        name: "general",
        type: "text",
      },
    );
    expect(chan.status).toBe(201);
    const channel = (await chan.json()) as Channel;

    await expectForbidden(
      await signedRequest(
        b.app,
        guest,
        "POST",
        `/api/groups/${otherGroup.id}/channels/${channel.id}/join`,
      ),
    );
    expect(groupsOf(b, guest.actor)).toEqual([own.id]);
  });

  test("creating a group → 403 and no group stored", async () => {
    const b = freshApp("create-group");
    const { guest } = await setup(b, {});

    await expectForbidden(
      await signedRequest(b.app, guest, "POST", "/api/groups", { name: "Mine" }),
    );
    const owned = b.db.drizzle.select().from(groups).where(eq(groups.owner, guest.actor)).all();
    expect(owned).toEqual([]);
  });

  test("a full account is unaffected: it joins an open group", async () => {
    const b = freshApp("full-account");
    const { otherGroup } = await setup(b, { tier: "public", joinPolicy: "open" });
    const bob = await registerUserWithKey(b.app, "bob");

    const res = await signedRequest(b.app, bob, "POST", `/api/groups/${otherGroup.id}/join`);
    expect(res.status).toBe(201);
  });
});
