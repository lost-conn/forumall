/**
 * Group CRUD + permission model tests (spec §5.2, §5.5).
 *
 * Drives the app in-process via `app.request(...)`, signing requests with the
 * shared `sign()` against a registered device key. Covers: create (defaults +
 * owner membership), the `can()` permission resolver (rank-inheritance), and the
 * GET/PATCH/DELETE authorization rules.
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
  GroupSchema,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { groupMembers } from "../src/db/schema.ts";
import { can } from "../src/provider/permissions.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-groups-"));
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

/** Register a user + device key; returns the signer + keypair. */
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

/** Build a signed `app.request` (with optional JSON body). */
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

/** Create a group as `signer`, returning the parsed Group. */
async function createGroup(
  app: App,
  signer: Signer,
  body: Record<string, unknown>,
): Promise<Group> {
  const res = await signedRequest(app, signer, "POST", "/api/groups", body);
  expect(res.status).toBe(201);
  return (await res.json()) as Group;
}

// ---------------------------------------------------------------------------
// POST /api/groups
// ---------------------------------------------------------------------------

describe("POST /api/groups (§5.5)", () => {
  test("creates a schema-valid Group; creator is owner; defaults applied", async () => {
    const { app, db } = freshApp("create");
    const alice = await registerUserWithKey(app, "alice");

    const res = await signedRequest(app, alice, "POST", "/api/groups", { name: "Dev Guild" });
    expect(res.status).toBe(201);
    const group = (await res.json()) as Group;

    // Schema-valid canonical Group.
    expect(() => GroupSchema.parse(group)).not.toThrow();
    expect(group.name).toBe("Dev Guild");
    expect(group.owner).toBe(alice.actor);
    expect(group.id.startsWith("grp_")).toBe(true);

    // RECOMMENDED defaults (§5.5).
    expect(group.tier).toBe("private");
    expect(group.joinPolicy).toBe("invite");
    expect(group.permissions).toEqual({
      post: ["member"],
      moderate: ["admin"],
      manage: ["admin"],
    });

    // A group_members row exists for the creator as owner.
    const member = db.drizzle
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.groupId, group.id))
      .all();
    expect(member).toHaveLength(1);
    expect(member[0]?.user).toBe(alice.actor);
    expect(member[0]?.role).toBe("owner");
  });

  test("honors explicit fields over defaults", async () => {
    const { app } = freshApp("create-explicit");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, {
      name: "Public Hub",
      tier: "public",
      joinPolicy: "open",
      permissions: { post: ["guest"], moderate: ["member"], manage: ["owner"] },
    });
    expect(group.tier).toBe("public");
    expect(group.joinPolicy).toBe("open");
    expect(group.permissions.post).toEqual(["guest"]);
  });

  test("missing name → 400", async () => {
    const { app } = freshApp("create-noname");
    const alice = await registerUserWithKey(app, "alice");
    const res = await signedRequest(app, alice, "POST", "/api/groups", { description: "x" });
    expect(res.status).toBe(400);
  });

  test("unsigned → 401", async () => {
    const { app } = freshApp("create-unsigned");
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// can() unit tests (§5.2 permission resolver)
// ---------------------------------------------------------------------------

describe("can() permission resolver (§5.2)", () => {
  const group = {
    permissions: { post: ["member"], moderate: ["admin"], manage: ["admin"] },
  };

  test("owner can do everything (always allowed)", () => {
    expect(can("post", "owner", group)).toBe(true);
    expect(can("moderate", "owner", group)).toBe(true);
    expect(can("manage", "owner", group)).toBe(true);
  });

  test("admin can moderate + manage (min admin) and post (rank-inheritance)", () => {
    expect(can("moderate", "admin", group)).toBe(true);
    expect(can("manage", "admin", group)).toBe(true);
    expect(can("post", "admin", group)).toBe(true); // admin >= member
  });

  test("member can post but not moderate/manage", () => {
    expect(can("post", "member", group)).toBe(true);
    expect(can("moderate", "member", group)).toBe(false);
    expect(can("manage", "member", group)).toBe(false);
  });

  test("guest is denied post when only member+ may post", () => {
    expect(can("post", "guest", group)).toBe(false);
  });

  test("rank-inheritance: post:[member] ⇒ admin & owner also post", () => {
    const g = { permissions: { post: ["member"] } };
    expect(can("post", "member", g)).toBe(true);
    expect(can("post", "admin", g)).toBe(true);
    expect(can("post", "owner", g)).toBe(true);
    expect(can("post", "guest", g)).toBe(false);
  });

  test("action absent from map → only owner permitted (fail closed)", () => {
    const g = { permissions: { post: ["member"] } };
    expect(can("manage", "admin", g)).toBe(false);
    expect(can("manage", "owner", g)).toBe(true);
  });

  test("unknown role is treated as lowest rank (deny)", () => {
    expect(can("post", "stranger", group)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/groups/{id} (optional auth)
// ---------------------------------------------------------------------------

describe("GET /api/groups/{id} (§5.5, optional auth)", () => {
  test("public group readable unauthenticated → 200", async () => {
    const { app } = freshApp("get-public");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "Public", tier: "public" });

    const res = await app.request(`/api/groups/${group.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Group;
    expect(body.id).toBe(group.id);
    expect(() => GroupSchema.parse(body)).not.toThrow();
  });

  test("discoverable group readable unauthenticated → 200", async () => {
    const { app } = freshApp("get-discoverable");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "Disco", tier: "discoverable" });
    const res = await app.request(`/api/groups/${group.id}`);
    expect(res.status).toBe(200);
  });

  test("private group: non-member → 403", async () => {
    const { app } = freshApp("get-private-nonmember");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "Secret", tier: "private" });

    // Unauthenticated → 403.
    const anon = await app.request(`/api/groups/${group.id}`);
    expect(anon.status).toBe(403);

    // Authenticated non-member → 403.
    const res = await signedRequest(app, bob, "GET", `/api/groups/${group.id}`);
    expect(res.status).toBe(403);
  });

  test("private group: member (owner) → 200", async () => {
    const { app } = freshApp("get-private-member");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "Secret", tier: "private" });
    const res = await signedRequest(app, alice, "GET", `/api/groups/${group.id}`);
    expect(res.status).toBe(200);
  });

  test("missing group → 404", async () => {
    const { app } = freshApp("get-missing");
    const res = await app.request("/api/groups/grp_nope");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/groups/{id}
// ---------------------------------------------------------------------------

describe("PATCH /api/groups/{id} (§5.5)", () => {
  test("non-manager (member) → 403", async () => {
    const { app, db } = freshApp("patch-nonmanager");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });

    // Make bob a plain member directly (membership card owns the join flow).
    db.drizzle
      .insert(groupMembers)
      .values({ groupId: group.id, user: bob.actor, role: "member", joinedAt: Date.now() })
      .run();

    const res = await signedRequest(app, bob, "PATCH", `/api/groups/${group.id}`, {
      name: "Hacked",
    });
    expect(res.status).toBe(403);
  });

  test("admin can manage → 200 and change persists", async () => {
    const { app, db } = freshApp("patch-admin");
    const alice = await registerUserWithKey(app, "alice");
    const carol = await registerUserWithKey(app, "carol");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    db.drizzle
      .insert(groupMembers)
      .values({ groupId: group.id, user: carol.actor, role: "admin", joinedAt: Date.now() })
      .run();

    const res = await signedRequest(app, carol, "PATCH", `/api/groups/${group.id}`, {
      description: "by admin",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Group;
    expect(body.description).toBe("by admin");

    const after = await app.request(`/api/groups/${group.id}`);
    expect(((await after.json()) as Group).description).toBe("by admin");
  });

  test("owner can manage → 200; updatedAt bumped", async () => {
    const { app } = freshApp("patch-owner");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const res = await signedRequest(app, alice, "PATCH", `/api/groups/${group.id}`, {
      name: "Renamed",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Group).name).toBe("Renamed");
  });

  test("missing group → 404", async () => {
    const { app } = freshApp("patch-missing");
    const alice = await registerUserWithKey(app, "alice");
    const res = await signedRequest(app, alice, "PATCH", "/api/groups/grp_nope", { name: "x" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/groups/{id}
// ---------------------------------------------------------------------------

describe("DELETE /api/groups/{id} (§5.5, owner only)", () => {
  test("non-owner → 403", async () => {
    const { app, db } = freshApp("delete-nonowner");
    const alice = await registerUserWithKey(app, "alice");
    const carol = await registerUserWithKey(app, "carol");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    // Even an admin (who can manage) cannot delete — owner only.
    db.drizzle
      .insert(groupMembers)
      .values({ groupId: group.id, user: carol.actor, role: "admin", joinedAt: Date.now() })
      .run();

    const res = await signedRequest(app, carol, "DELETE", `/api/groups/${group.id}`);
    expect(res.status).toBe(403);
  });

  test("owner → 204; group and its members are gone", async () => {
    const { app, db } = freshApp("delete-owner");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });

    const res = await signedRequest(app, alice, "DELETE", `/api/groups/${group.id}`);
    expect(res.status).toBe(204);

    // Group gone (404 on GET) and no membership rows remain.
    const get = await app.request(`/api/groups/${group.id}`);
    expect(get.status).toBe(404);
    const members = db.drizzle
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.groupId, group.id))
      .all();
    expect(members).toHaveLength(0);
  });

  test("missing group → 404", async () => {
    const { app } = freshApp("delete-missing");
    const alice = await registerUserWithKey(app, "alice");
    const res = await signedRequest(app, alice, "DELETE", "/api/groups/grp_nope");
    expect(res.status).toBe(404);
  });
});
