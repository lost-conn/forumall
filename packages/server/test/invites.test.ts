/**
 * Invites / join links + guest accounts tests (spec §5.6, §4.8).
 *
 * Drives the app in-process via `app.request(...)`, signing requests with the
 * shared `sign()` against a registered device key (mirrors membership.test.ts).
 * Covers invite create/list/revoke (manage-gated), redeem as an existing account
 * (incl. maxUses exhaustion + expiry), and guest provisioning (incl. the keys
 * endpoint, group membership, grantsGuest=false 403, and non-Ed25519 400).
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
  type Invite,
  InviteSchema,
  type UserProfile,
  UserProfileSchema,
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
  tmp = mkdtempSync(join(tmpdir(), "forumall-invites-"));
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

/** Mint an invite as `signer` (a manager) and return the created Invite (+ link). */
async function createInvite(
  app: App,
  signer: Signer,
  groupId: string,
  body: Record<string, unknown> = {},
): Promise<Invite & { link?: string }> {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/invites`, body);
  expect(res.status).toBe(201);
  return (await res.json()) as Invite & { link?: string };
}

// ---------------------------------------------------------------------------
// Invite management (§5.6)
// ---------------------------------------------------------------------------

describe("Invite management (§5.6)", () => {
  test("manager creates an invite → 201 with token; non-manager → 403", async () => {
    const { app } = freshApp("inv-create");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      joinPolicy: "invite",
    });

    const res = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/invites`, {
      role: "member",
    });
    expect(res.status).toBe(201);
    const invite = (await res.json()) as Invite & { link: string };
    expect(() => InviteSchema.parse(invite)).not.toThrow();
    expect(typeof invite.token).toBe("string");
    expect(invite.token.length).toBeGreaterThan(10);
    expect(invite.link).toBe(`https://${DOMAIN}/invite/${invite.token}`);

    // A non-manager (non-member) cannot create an invite.
    const denied = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/invites`, {});
    expect(denied.status).toBe(403);
  });

  test("list + revoke; a revoked token can no longer be redeemed (404)", async () => {
    const { app } = freshApp("inv-revoke");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      joinPolicy: "invite",
    });

    const invite = await createInvite(app, alice, group.id, {});

    // List shows the invite.
    const listRes = await signedRequest(app, alice, "GET", `/api/groups/${group.id}/invites`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Invite[] };
    expect(list.items.map((i) => i.id)).toContain(invite.id);

    // Revoke → 204.
    const del = await signedRequest(
      app,
      alice,
      "DELETE",
      `/api/groups/${group.id}/invites/${invite.id}`,
    );
    expect(del.status).toBe(204);

    // The revoked token can no longer be redeemed.
    const redeem = await signedRequest(app, bob, "POST", `/api/invites/${invite.token}/redeem`);
    expect(redeem.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Redeem as existing account (§5.6)
// ---------------------------------------------------------------------------

describe("Redeem invite as existing account (§5.6)", () => {
  test("redeem → 200; caller is now a member with the invite role", async () => {
    const { app, db } = freshApp("inv-redeem");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      joinPolicy: "invite",
    });
    const invite = await createInvite(app, alice, group.id, { role: "member" });

    const res = await signedRequest(app, bob, "POST", `/api/invites/${invite.token}/redeem`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groupId: string; role: string };
    expect(body.groupId).toBe(group.id);
    expect(body.role).toBe("member");

    // bob is now a member with the invite role.
    const rows = db.drizzle
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.user, bob.actor))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("member");
  });

  test("maxUses exhausted → 409 (maxUses:1, redeem twice)", async () => {
    const { app } = freshApp("inv-maxuses");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const carol = await registerUserWithKey(app, "carol");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      joinPolicy: "invite",
    });
    const invite = await createInvite(app, alice, group.id, { maxUses: 1 });

    const first = await signedRequest(app, bob, "POST", `/api/invites/${invite.token}/redeem`);
    expect(first.status).toBe(200);

    const second = await signedRequest(app, carol, "POST", `/api/invites/${invite.token}/redeem`);
    expect(second.status).toBe(409);
  });

  test("expired invite → 404", async () => {
    const { app } = freshApp("inv-expired");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      joinPolicy: "invite",
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const invite = await createInvite(app, alice, group.id, { expiresAt: past });

    const res = await signedRequest(app, bob, "POST", `/api/invites/${invite.token}/redeem`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Guest provisioning (§5.6, §4.8)
// ---------------------------------------------------------------------------

describe("Guest provisioning (§4.8)", () => {
  test("grantsGuest invite + unsigned guest body → 201 guest profile + working key", async () => {
    const { app, db } = freshApp("inv-guest");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      joinPolicy: "invite",
    });
    const invite = await createInvite(app, alice, group.id, { grantsGuest: true });

    const { publicKey } = generateKeyPair();
    const res = await app.request(`/api/invites/${invite.token}/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Guest Ada",
        public_key: publicKey,
        algorithm: "Ed25519",
        device_name: "Chrome on Windows",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      actor: string;
      key_id: string;
      profile: UserProfile;
      groupId: string;
      role: string;
    };

    expect(() => UserProfileSchema.parse(body.profile)).not.toThrow();
    expect(body.profile.guest).toBe(true);
    expect(body.profile.displayName).toBe("Guest Ada");
    expect(body.profile.domain).toBe(DOMAIN);
    expect(typeof body.key_id).toBe("string");
    expect(body.groupId).toBe(group.id);
    expect(body.role).toBe("guest");

    // actor is guest_x@domain.
    expect(body.actor).toBe(`${body.profile.handle}@${DOMAIN}`);
    expect(body.profile.handle.startsWith("guest_")).toBe(true);

    // The guest is a group member.
    const rows = db.drizzle
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.user, body.actor))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("guest");

    // The guest's key resolves via the keys endpoint (§4.6).
    const keysRes = await app.request(`/.well-known/ofscp/users/${body.profile.handle}/keys`);
    expect(keysRes.status).toBe(200);
    const keys = (await keysRes.json()) as { keys: { key_id: string; public_key: string }[] };
    expect(keys.keys.map((k) => k.key_id)).toContain(body.key_id);
    expect(keys.keys.map((k) => k.public_key)).toContain(publicKey);
  });

  test("grantsGuest=false → guest endpoint 403", async () => {
    const { app } = freshApp("inv-guest-forbidden");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      joinPolicy: "invite",
    });
    const invite = await createInvite(app, alice, group.id, { grantsGuest: false });

    const { publicKey } = generateKeyPair();
    const res = await app.request(`/api/invites/${invite.token}/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        public_key: publicKey,
        algorithm: "Ed25519",
        device_name: "dev",
      }),
    });
    expect(res.status).toBe(403);
  });

  test("guest device key non-Ed25519 → 400", async () => {
    const { app } = freshApp("inv-guest-alg");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, {
      name: "G",
      tier: "public",
      joinPolicy: "invite",
    });
    const invite = await createInvite(app, alice, group.id, { grantsGuest: true });

    const { publicKey } = generateKeyPair();
    const res = await app.request(`/api/invites/${invite.token}/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        public_key: publicKey,
        algorithm: "RSA",
        device_name: "dev",
      }),
    });
    expect(res.status).toBe(400);
  });
});
