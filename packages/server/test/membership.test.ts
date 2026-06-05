/**
 * Membership + join-request tests (spec §5.7, §7.2).
 *
 * Drives the app in-process via `app.request(...)`, signing requests with the
 * shared `sign()` against a registered device key. Covers join (open/request/
 * invite), leave + owner-transfer rule, the opaque-cursor member listing, role
 * changes (incl. single-owner transfer), kicks (role-rank rule), and the
 * approve/deny join-request flow.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Group,
  type JoinRequest,
  JoinRequestSchema,
  type Member,
  MemberSchema,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { type Db, openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { groupMembers } from "../src/db/schema.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-membership-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db });
  return { app, config, db };
}

type App = ReturnType<typeof freshApp>["app"];

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
}

async function registerUserWithKey(app: App, handle: string): Promise<Signer> {
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const res = await app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}` };
}

function signedRequest(app: App, signer: Signer, method: string, path: string, bodyObj?: unknown) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
  return app.request(path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

async function createGroup(
  app: App,
  signer: Signer,
  body: Record<string, unknown>,
): Promise<Group> {
  const res = await signedRequest(app, signer, "POST", "/api/groups", body);
  expect(res.status).toBe(201);
  return (await res.json()) as Group;
}

/** Directly insert a membership row (bypassing the join flow) for setup. */
function seedMember(db: Db, groupId: string, user: string, role: string, joinedAt = Date.now()) {
  db.drizzle.insert(groupMembers).values({ groupId, user, role, joinedAt }).run();
}

/** URL-encoded actor for use in a `{userRef}` path segment. */
function ref(actor: string): string {
  return encodeURIComponent(actor);
}

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
      const actor = `m${i}@${DOMAIN}`;
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
      const res = await app.request(url);
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

  test("private group: non-member → 403", async () => {
    const { app } = freshApp("members-private");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "Secret", tier: "private" });

    const anon = await app.request(`/api/groups/${group.id}/members`);
    expect(anon.status).toBe(403);
    const res = await signedRequest(app, bob, "GET", `/api/groups/${group.id}/members`);
    expect(res.status).toBe(403);
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

  test("kicking an equal/higher-ranked member → 403", async () => {
    const { app, db } = freshApp("kick-equal");
    const alice = await registerUserWithKey(app, "alice");
    const mod = await registerUserWithKey(app, "moduser");
    const other = await registerUserWithKey(app, "otheradmin");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    seedMember(db, group.id, mod.actor, "admin");
    seedMember(db, group.id, other.actor, "admin"); // equal rank

    const res = await signedRequest(
      app,
      mod,
      "DELETE",
      `/api/groups/${group.id}/members/${ref(other.actor)}`,
    );
    expect(res.status).toBe(403);
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
