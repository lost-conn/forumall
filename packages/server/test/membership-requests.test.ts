/**
 * Join-request tests (spec §5.7, request policy): listing, approve, deny.
 * Shared setup is `helpers/membership-app.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type JoinRequest, JoinRequestSchema, type Member, MemberSchema } from "@forumall/shared";
import { eq } from "drizzle-orm";
import { groupMembers } from "../src/db/schema.ts";
import {
  createGroup,
  ref,
  registerUserWithKey,
  seedMember,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("membership-requests");

// ---------------------------------------------------------------------------
// Join requests: list / approve / deny
// ---------------------------------------------------------------------------

describe("Join requests (§5.7, request policy)", () => {
  test("approve creates membership → 200 Member; user is now a member", async () => {
    const { app, db } = freshApp("req-approve");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "Req",
      tier: "public",
      joinPolicy: "request",
    });

    const reqRes = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/join`);
    expect(reqRes.status).toBe(202);
    const jr = (await reqRes.json()) as JoinRequest;

    const approve = await signedRequest(
      app,
      alice,
      "POST",
      `/api/groups/${group.id}/requests/${jr.id}/approve`,
    );
    expect(approve.status).toBe(200);
    const member = (await approve.json()) as Member;
    expect(() => MemberSchema.parse(member)).not.toThrow();
    expect(member.user).toBe(bob.actor);
    expect(member.role).toBe("member");

    // bob is now a member.
    expect(
      db.drizzle.select().from(groupMembers).where(eq(groupMembers.user, bob.actor)).all(),
    ).toHaveLength(1);

    // The request is no longer pending → re-approve 404s.
    const again = await signedRequest(
      app,
      alice,
      "POST",
      `/api/groups/${group.id}/requests/${jr.id}/approve`,
    );
    expect(again.status).toBe(404);
  });

  test("deny → 204; request no longer pending", async () => {
    const { app, db } = freshApp("req-deny");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "Req",
      tier: "public",
      joinPolicy: "request",
    });
    const jr = (await (
      await signedRequest(app, bob, "POST", `/api/groups/${group.id}/join`)
    ).json()) as JoinRequest;

    const deny = await signedRequest(
      app,
      alice,
      "POST",
      `/api/groups/${group.id}/requests/${jr.id}/deny`,
    );
    expect(deny.status).toBe(204);
    // Not a member.
    expect(
      db.drizzle.select().from(groupMembers).where(eq(groupMembers.user, bob.actor)).all(),
    ).toHaveLength(0);
  });

  test("listing requires manage/moderate (a plain member → 403)", async () => {
    const { app, db } = freshApp("req-list-auth");
    const alice = await registerUserWithKey(app, "alice");
    const member = await registerUserWithKey(app, "plain");
    const mod = await registerUserWithKey(app, "moduser");
    const group = await createGroup(app, alice, {
      name: "Req",
      tier: "public",
      joinPolicy: "request",
    });
    seedMember(db, group.id, member.actor, "member");
    seedMember(db, group.id, mod.actor, "admin");

    const denied = await signedRequest(app, member, "GET", `/api/groups/${group.id}/requests`);
    expect(denied.status).toBe(403);

    // A manager (admin) can list.
    const ok = await signedRequest(app, mod, "GET", `/api/groups/${group.id}/requests`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(((await ok.json()) as { items: JoinRequest[] }).items)).toBe(true);
  });
});
