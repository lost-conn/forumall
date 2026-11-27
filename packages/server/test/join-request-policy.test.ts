/**
 * Join requests across join-policy and tier changes (spec §5.7): pending
 * requests survive a `PATCH`; approve answers `409` while the effective join
 * policy is `invite` (a `private` tier included), checked before the
 * already-a-member case, and leaves the request pending; deny works under any
 * policy; approval resumes under `request` or `open`. Shared setup is
 * `helpers/membership-app.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type JoinRequest, type Member, MemberSchema } from "@forumall/shared";

import {
  type App,
  type Signer,
  createGroup,
  registerUserWithKey,
  seedMember,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("join-request-policy");

/** A `request`-policy group owned by alice with a pending request from bob. */
async function pendingRequest(name: string) {
  const b = freshApp(name);
  const alice = await registerUserWithKey(b.app, "alice");
  const bob = await registerUserWithKey(b.app, "bob");
  const group = await createGroup(b.app, alice, {
    name: "Req",
    tier: "public",
    joinPolicy: "request",
  });
  const res = await signedRequest(b.app, bob, "POST", `/api/groups/${group.id}/join`);
  expect(res.status).toBe(202);
  const request = (await res.json()) as JoinRequest;
  return { ...b, alice, bob, group, request };
}

async function patchGroup(
  app: App,
  signer: Signer,
  groupId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await signedRequest(app, signer, "PATCH", `/api/groups/${groupId}`, body);
  expect(res.status).toBe(200);
}

async function pendingIds(app: App, signer: Signer, groupId: string): Promise<string[]> {
  const res = await signedRequest(app, signer, "GET", `/api/groups/${groupId}/requests`);
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: JoinRequest[] };
  for (const item of items) expect(item.state).toBe("pending");
  return items.map((r) => r.id);
}

function approve(app: App, signer: Signer, groupId: string, requestId: string) {
  return signedRequest(app, signer, "POST", `/api/groups/${groupId}/requests/${requestId}/approve`);
}

describe("join requests across policy changes (§5.7)", () => {
  test("joinPolicy → invite: request kept pending; approve → 409 conflict; approvable again under request", async () => {
    const { app, alice, group, request } = await pendingRequest("to-invite");

    await patchGroup(app, alice, group.id, { joinPolicy: "invite" });
    expect(await pendingIds(app, alice, group.id)).toEqual([request.id]);

    const refused = await approve(app, alice, group.id, request.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { errorCode: string }).errorCode).toBe("conflict");
    expect(await pendingIds(app, alice, group.id)).toEqual([request.id]);

    await patchGroup(app, alice, group.id, { joinPolicy: "request" });
    const ok = await approve(app, alice, group.id, request.id);
    expect(ok.status).toBe(200);
    expect(MemberSchema.parse(await ok.json()).role).toBe("member");
  });

  test("tier → private makes the group invite-only: approve → 409, request kept", async () => {
    const { app, alice, group, request } = await pendingRequest("to-private");

    await patchGroup(app, alice, group.id, { tier: "private" });
    expect(await pendingIds(app, alice, group.id)).toEqual([request.id]);
    expect((await approve(app, alice, group.id, request.id)).status).toBe(409);
    expect(await pendingIds(app, alice, group.id)).toEqual([request.id]);
  });

  test("the policy is checked first: a requester who is already a member still gets 409", async () => {
    const { app, db, alice, bob, group, request } = await pendingRequest("member-409");
    seedMember(db, group.id, bob.actor, "member");

    await patchGroup(app, alice, group.id, { joinPolicy: "invite" });
    expect((await approve(app, alice, group.id, request.id)).status).toBe(409);
    expect(await pendingIds(app, alice, group.id)).toEqual([request.id]);
  });

  test("under `open`, approval creates the membership with role member", async () => {
    const { app, alice, bob, group, request } = await pendingRequest("to-open");

    await patchGroup(app, alice, group.id, { joinPolicy: "open" });
    expect(await pendingIds(app, alice, group.id)).toEqual([request.id]);
    const ok = await approve(app, alice, group.id, request.id);
    expect(ok.status).toBe(200);
    const member = (await ok.json()) as Member;
    expect(member).toMatchObject({ user: bob.actor, role: "member" });
    expect(await pendingIds(app, alice, group.id)).toEqual([]);
  });

  test("deny still works while the group is invite-only", async () => {
    const { app, alice, group, request } = await pendingRequest("deny-invite");

    await patchGroup(app, alice, group.id, { tier: "private", joinPolicy: "invite" });
    const deny = await signedRequest(
      app,
      alice,
      "POST",
      `/api/groups/${group.id}/requests/${request.id}/deny`,
    );
    expect(deny.status).toBe(204);
    expect(await pendingIds(app, alice, group.id)).toEqual([]);
  });
});
