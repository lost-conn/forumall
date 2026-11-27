/**
 * Membership tests (spec §5.7, §7.2): join (open/request/invite), leave +
 * owner-transfer rule, the opaque-cursor member listing, role changes (incl.
 * single-owner transfer) and kicks (role-rank rule). The join-request
 * approve/deny flow is in `membership-requests.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type JoinRequest, JoinRequestSchema, type Member, MemberSchema } from "@forumall/shared";
import { eq } from "drizzle-orm";
import { groupMembers } from "../src/db/schema.ts";
import {
  DOMAIN,
  createGroup,
  ref,
  registerUserWithKey,
  seedMember,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("membership");

// ---------------------------------------------------------------------------
// POST /join
// ---------------------------------------------------------------------------

describe("POST /api/groups/{groupId}/join (§5.7)", () => {
  test("open group → 201 Member", async () => {
    const { app } = freshApp("join-open");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "Open",
      tier: "public",
      joinPolicy: "open",
    });

    const res = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/join`);
    expect(res.status).toBe(201);
    const member = (await res.json()) as Member;
    expect(() => MemberSchema.parse(member)).not.toThrow();
    expect(member.user).toBe(bob.actor);
    expect(member.role).toBe("member");
  });

  test("a private-tier group is invite-only even with joinPolicy open (§11)", async () => {
    const { app } = freshApp("join-private-open");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "Secret",
      tier: "private",
      joinPolicy: "open",
    });

    const res = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/join`);
    expect(res.status).toBe(403);

    // The channel-join alias (§8.2) applies the same rule.
    const ch = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/channels`, {
      type: "text",
      name: "general",
      tier: "private",
    });
    expect(ch.status).toBe(201);
    const channelId = ((await ch.json()) as { id: string }).id;
    const viaChannel = await signedRequest(
      app,
      bob,
      "POST",
      `/api/groups/${group.id}/channels/${channelId}/join`,
    );
    expect(viaChannel.status).toBe(403);
  });

  test("request group → 202 JoinRequest; repeat returns the same pending one", async () => {
    const { app, db } = freshApp("join-request");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "Req",
      tier: "public",
      joinPolicy: "request",
    });

    const res1 = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/join`, {
      message: "please",
    });
    expect(res1.status).toBe(202);
    const jr1 = (await res1.json()) as JoinRequest;
    expect(() => JoinRequestSchema.parse(jr1)).not.toThrow();
    expect(jr1.state).toBe("pending");
    expect(jr1.user).toBe(bob.actor);
    expect(jr1.message).toBe("please");

    // Idempotent: a second join while pending returns the SAME request.
    const res2 = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/join`);
    expect(res2.status).toBe(202);
    const jr2 = (await res2.json()) as JoinRequest;
    expect(jr2.id).toBe(jr1.id);

    // Not yet a member — only the owner is in group_members.
    expect(
      db.drizzle.select().from(groupMembers).where(eq(groupMembers.groupId, group.id)).all(),
    ).toHaveLength(1);
  });

  test("invite group → 403", async () => {
    const { app } = freshApp("join-invite");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "Inv",
      tier: "public",
      joinPolicy: "invite",
    });

    const res = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/join`);
    expect(res.status).toBe(403);
  });

  test("already a member → 200 with their membership", async () => {
    const { app } = freshApp("join-already");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, {
      name: "Open",
      joinPolicy: "open",
      tier: "public",
    });
    const res = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/join`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Member).role).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// POST /leave
// ---------------------------------------------------------------------------

describe("POST /api/groups/{groupId}/leave (§5.7)", () => {
  test("member leaves → 204", async () => {
    const { app, db } = freshApp("leave-member");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, bob.actor, "member");

    const res = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/leave`);
    expect(res.status).toBe(204);
    expect(
      db.drizzle.select().from(groupMembers).where(eq(groupMembers.user, bob.actor)).all(),
    ).toHaveLength(0);
  });

  test("owner leave without transfer → 409; after transfer they can leave", async () => {
    const { app, db } = freshApp("leave-owner");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, bob.actor, "admin");

    // Owner cannot leave yet.
    const blocked = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/leave`);
    expect(blocked.status).toBe(409);

    // Transfer ownership to bob (owner-only action).
    const transfer = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(bob.actor)}`,
      { role: "owner" },
    );
    expect(transfer.status).toBe(200);
    expect(((await transfer.json()) as Member).role).toBe("owner");

    // Ex-owner alice is now admin and can leave.
    const after = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/leave`);
    expect(after.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// GET /members (pagination, §7.2)
// ---------------------------------------------------------------------------

describe("GET /api/groups/{groupId}/members (§5.7, §7.2)", () => {
  test("paginated shape; nextCursor walks all members without overlap or gap", async () => {
    const { app, db } = freshApp("members-page");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });

    // Seed > pageSize members (owner + 11 = 12). Use distinct joinedAt and also
    // some shared joinedAt to exercise the (joinedAt, user) tie-break.
    const expected = new Set<string>([alice.actor]);
    const base = Date.now();
    for (let i = 0; i < 11; i++) {
      const actor = `mem${i}@${DOMAIN}`;
      // Two members share a joinedAt to exercise the tie-break.
      seedMember(db, group.id, actor, "member", base + Math.floor(i / 2));
      expected.add(actor);
    }

    const pageSize = 5;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/api/groups/${group.id}/members?limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await signedRequest(app, alice, "GET", url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Member[];
        page: { nextCursor: string | null };
      };
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeLessThanOrEqual(pageSize);
      for (const m of body.items) {
        expect(() => MemberSchema.parse(m)).not.toThrow();
        seen.push(m.user);
      }
      cursor = body.page.nextCursor;
      pages++;
      if (pages > 10) throw new Error("pagination did not terminate");
    } while (cursor);

    // No overlap (every user seen exactly once) and no gap (all 12 seen).
    expect(seen.length).toBe(expected.size);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(new Set(seen)).toEqual(expected);
  });

  test("not an anonymous-reader route: unsigned → 401 even for a public group (§4.5, §5.7)", async () => {
    const { app } = freshApp("members-unsigned");
    const alice = await registerUserWithKey(app, "alice");
    for (const tier of ["public", "discoverable", "private", "group"]) {
      const group = await createGroup(app, alice, { name: tier, tier });
      const res = await app.request(`/api/groups/${group.id}/members`);
      expect({ tier, status: res.status }).toEqual({ tier, status: 401 });
      expect(((await res.json()) as { errorCode: string }).errorCode).toBe("unauthorized");
    }
  });

  test("public/discoverable group: a signed non-member may list members", async () => {
    const { app } = freshApp("members-public-nonmember");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    for (const tier of ["public", "discoverable"]) {
      const group = await createGroup(app, alice, { name: tier, tier });
      const res = await signedRequest(app, bob, "GET", `/api/groups/${group.id}/members`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Member[] };
      expect(body.items.map((m) => m.user)).toEqual([alice.actor]);
    }
  });

  test("private group: signed non-member → 403", async () => {
    const { app } = freshApp("members-private");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "Secret", tier: "private" });

    const res = await signedRequest(app, bob, "GET", `/api/groups/${group.id}/members`);
    expect(res.status).toBe(403);
    // A member of the private group may.
    const own = await signedRequest(app, alice, "GET", `/api/groups/${group.id}/members`);
    expect(own.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /members/{userRef} (role change)
// ---------------------------------------------------------------------------

describe("PATCH /api/groups/{groupId}/members/{userRef} (§5.7)", () => {
  test("non-manager (member) → 403", async () => {
    const { app, db } = freshApp("role-nonmanager");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const carol = await registerUserWithKey(app, "carol");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, bob.actor, "member");
    seedMember(db, group.id, carol.actor, "member");

    const res = await signedRequest(
      app,
      bob,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(carol.actor)}`,
      { role: "admin" },
    );
    expect(res.status).toBe(403);
  });

  test("admin promotes a member to admin → 200", async () => {
    const { app, db } = freshApp("role-admin-promote");
    const alice = await registerUserWithKey(app, "alice");
    const admin = await registerUserWithKey(app, "adminuser");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, admin.actor, "admin");
    seedMember(db, group.id, bob.actor, "member");

    const res = await signedRequest(
      app,
      admin,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(bob.actor)}`,
      { role: "admin" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Member).role).toBe("admin");
  });

  test("transferring owner by a non-owner manager → 403", async () => {
    const { app, db } = freshApp("role-transfer-nonowner");
    const alice = await registerUserWithKey(app, "alice");
    const admin = await registerUserWithKey(app, "adminuser");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, admin.actor, "admin");
    seedMember(db, group.id, bob.actor, "member");

    // admin can manage, but only the owner may transfer ownership.
    const res = await signedRequest(
      app,
      admin,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(bob.actor)}`,
      { role: "owner" },
    );
    expect(res.status).toBe(403);
  });

  test("owner transfers owner → new owner set + old owner demoted to admin", async () => {
    const { app, db } = freshApp("role-transfer-owner");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, bob.actor, "member");

    const res = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(bob.actor)}`,
      { role: "owner" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Member).role).toBe("owner");

    // Single-owner invariant: bob is owner, alice demoted to admin.
    const rows = db.drizzle
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.groupId, group.id))
      .all();
    const byUser = Object.fromEntries(rows.map((r) => [r.user, r.role]));
    expect(byUser[bob.actor]).toBe("owner");
    expect(byUser[alice.actor]).toBe("admin");
    expect(rows.filter((r) => r.role === "owner")).toHaveLength(1);
  });

  test("missing target member → 404", async () => {
    const { app } = freshApp("role-missing");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const res = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(`ghost@${DOMAIN}`)}`,
      { role: "admin" },
    );
    expect(res.status).toBe(404);
  });

  test("assigning a custom role from the group's catalogue → 200", async () => {
    const { app, db } = freshApp("role-custom-ok");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      roles: [{ name: "admin" }, { name: "moderator" }, { name: "member" }],
    });
    seedMember(db, group.id, bob.actor, "member");

    const res = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(bob.actor)}`,
      { role: "moderator" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Member).role).toBe("moderator");
  });

  test("assigning a role not in the catalogue → 400", async () => {
    const { app, db } = freshApp("role-unknown");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, bob.actor, "member");

    const res = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(bob.actor)}`,
      { role: "wizard" },
    );
    expect(res.status).toBe(400);
  });

  test("manager may not assign a role more privileged than their own → 403 (subset rule)", async () => {
    const { app, db } = freshApp("role-escalate");
    const alice = await registerUserWithKey(app, "alice");
    const mgr = await registerUserWithKey(app, "mgruser");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      // `lead` may manage but not moderate; `admin` holds moderate too.
      permissions: { post: ["member"], moderate: ["admin"], manage: ["lead", "admin"] },
      roles: [{ name: "admin" }, { name: "lead" }, { name: "member" }],
    });
    seedMember(db, group.id, mgr.actor, "lead");
    seedMember(db, group.id, bob.actor, "member");

    // lead can manage, but assigning `admin` would grant `moderate` (which lead lacks).
    const res = await signedRequest(
      app,
      mgr,
      "PATCH",
      `/api/groups/${group.id}/members/${ref(bob.actor)}`,
      { role: "admin" },
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /members/{userRef} (kick)
// ---------------------------------------------------------------------------

describe("DELETE /api/groups/{groupId}/members/{userRef} (§5.7)", () => {
  test("moderator kicks a lower-ranked member → 204", async () => {
    const { app, db } = freshApp("kick-lower");
    const alice = await registerUserWithKey(app, "alice");
    const mod = await registerUserWithKey(app, "moduser");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, mod.actor, "admin"); // admin satisfies moderate
    seedMember(db, group.id, bob.actor, "member");

    const res = await signedRequest(
      app,
      mod,
      "DELETE",
      `/api/groups/${group.id}/members/${ref(bob.actor)}`,
    );
    expect(res.status).toBe(204);
    expect(
      db.drizzle.select().from(groupMembers).where(eq(groupMembers.user, bob.actor)).all(),
    ).toHaveLength(0);
  });

  test("kicking a member who holds a permission the caller lacks → 403 (subset rule)", async () => {
    const { app, db } = freshApp("kick-subset");
    const alice = await registerUserWithKey(app, "alice");
    const mod = await registerUserWithKey(app, "moduser");
    const admin = await registerUserWithKey(app, "adminuser");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      // `mod` may moderate but not manage; `admin` holds manage too.
      permissions: { post: ["member"], moderate: ["mod", "admin"], manage: ["admin"] },
      roles: [{ name: "admin" }, { name: "mod" }, { name: "member" }],
    });
    seedMember(db, group.id, mod.actor, "mod");
    seedMember(db, group.id, admin.actor, "admin");

    const res = await signedRequest(
      app,
      mod,
      "DELETE",
      `/api/groups/${group.id}/members/${ref(admin.actor)}`,
    );
    expect(res.status).toBe(403);
  });

  test("equal roles may kick each other → 204 (subset satisfied)", async () => {
    const { app, db } = freshApp("kick-equal-ok");
    const alice = await registerUserWithKey(app, "alice");
    const mod = await registerUserWithKey(app, "moduser");
    const other = await registerUserWithKey(app, "otheradmin");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, mod.actor, "admin");
    seedMember(db, group.id, other.actor, "admin");

    const res = await signedRequest(
      app,
      mod,
      "DELETE",
      `/api/groups/${group.id}/members/${ref(other.actor)}`,
    );
    expect(res.status).toBe(204);
  });

  test("kicking the owner → 403", async () => {
    const { app, db } = freshApp("kick-owner");
    const alice = await registerUserWithKey(app, "alice");
    const mod = await registerUserWithKey(app, "moduser");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, mod.actor, "admin");

    const res = await signedRequest(
      app,
      mod,
      "DELETE",
      `/api/groups/${group.id}/members/${ref(alice.actor)}`,
    );
    expect(res.status).toBe(403);
  });
});
