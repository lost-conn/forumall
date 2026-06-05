/**
 * Channel CRUD + tier enforcement tests (spec §5.2, §5.5).
 *
 * Drives the app in-process via `app.request(...)`, signing with the shared
 * `sign()` against a registered device key (same harness as `groups.test.ts`).
 * Covers: create authz (manager vs non-manager), `type` immutability on PATCH,
 * list visibility (public vs private per membership), single-channel tier reads,
 * delete authz, and the group-delete → channel cascade.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Channel,
  ChannelSchema,
  type Group,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { groupMembers } from "../src/db/schema.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-channels-"));
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
type Db = ReturnType<typeof freshApp>["db"];

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

/** Insert a membership row directly (membership card owns the real join flow). */
function addMember(db: Db, groupId: string, signer: Signer, role: string): void {
  db.drizzle
    .insert(groupMembers)
    .values({ groupId, user: signer.actor, role, joinedAt: Date.now() })
    .run();
}

async function createChannel(
  app: App,
  signer: Signer,
  groupId: string,
  body: Record<string, unknown>,
): Promise<Channel> {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/channels`, body);
  expect(res.status).toBe(201);
  return (await res.json()) as Channel;
}

// ---------------------------------------------------------------------------
// POST /api/groups/{groupId}/channels
// ---------------------------------------------------------------------------

describe("POST /api/groups/{groupId}/channels (§5.5)", () => {
  test("group manager (owner) creates a schema-valid Channel; type set; defaults", async () => {
    const { app } = freshApp("chan-create");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });

    const res = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/channels`, {
      name: "general",
      type: "text",
    });
    expect(res.status).toBe(201);
    const channel = (await res.json()) as Channel;

    expect(() => ChannelSchema.parse(channel)).not.toThrow();
    expect(channel.type).toBe("text");
    expect(channel.groupId).toBe(group.id);
    expect(channel.id.startsWith("chn_")).toBe(true);
    expect(channel.tier).toBe("private"); // RECOMMENDED default
  });

  test("call channel carries a derived static call summary", async () => {
    const { app } = freshApp("chan-call");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "call", name: "voice" });
    expect(channel.call).toEqual({ active: false, participants: [] });
  });

  test("non-manager (plain member) → 403", async () => {
    const { app, db } = freshApp("chan-create-nonmanager");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    addMember(db, group.id, bob, "member");

    const res = await signedRequest(app, bob, "POST", `/api/groups/${group.id}/channels`, {
      type: "text",
    });
    expect(res.status).toBe(403);
  });

  test("missing required `type` → 400", async () => {
    const { app } = freshApp("chan-create-notype");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const res = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/channels`, {
      name: "x",
    });
    expect(res.status).toBe(400);
  });

  test("unsigned → 401", async () => {
    const { app } = freshApp("chan-create-unsigned");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const res = await app.request(`/api/groups/${group.id}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "text" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// PATCH — type immutability + field updates
// ---------------------------------------------------------------------------

describe("PATCH /api/groups/{groupId}/channels/{channelId} (§5.5)", () => {
  test("attempting to change `type` is rejected (400); type unchanged", async () => {
    const { app } = freshApp("chan-patch-type");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", name: "general" });

    const res = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/channels/${channel.id}`,
      { type: "call" },
    );
    expect(res.status).toBe(400);

    // The channel's type is untouched.
    const after = await signedRequest(
      app,
      alice,
      "GET",
      `/api/groups/${group.id}/channels/${channel.id}`,
    );
    expect(((await after.json()) as Channel).type).toBe("text");
  });

  test("other fields update fine (name/tier/topic/tags) → 200", async () => {
    const { app } = freshApp("chan-patch-fields");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", name: "general" });

    const res = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/channels/${channel.id}`,
      { name: "renamed", tier: "group", topic: "stuff", tags: ["a", "b"] },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Channel;
    expect(body.name).toBe("renamed");
    expect(body.tier).toBe("group");
    expect(body.topic).toBe("stuff");
    expect(body.tags).toEqual(["a", "b"]);
    expect(body.type).toBe("text");
  });

  test("non-manager → 403; missing channel → 404", async () => {
    const { app, db } = freshApp("chan-patch-authz");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text" });
    addMember(db, group.id, bob, "member");

    const forbidden = await signedRequest(
      app,
      bob,
      "PATCH",
      `/api/groups/${group.id}/channels/${channel.id}`,
      { name: "x" },
    );
    expect(forbidden.status).toBe(403);

    const missing = await signedRequest(
      app,
      alice,
      "PATCH",
      `/api/groups/${group.id}/channels/chn_nope`,
      { name: "x" },
    );
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET list — visibility
// ---------------------------------------------------------------------------

describe("GET /api/groups/{groupId}/channels (§5.5, visibility)", () => {
  test("non-member sees only public channel; member sees both", async () => {
    const { app, db } = freshApp("chan-list-visibility");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    // Public group so a non-member can read the group + its public channels.
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const pub = await createChannel(app, alice, group.id, { type: "text", tier: "public" });
    const priv = await createChannel(app, alice, group.id, { type: "text", tier: "private" });

    // Unauthenticated caller: only the public channel.
    const anon = await app.request(`/api/groups/${group.id}/channels`);
    expect(anon.status).toBe(200);
    const anonItems = ((await anon.json()) as { items: Channel[] }).items;
    expect(anonItems.map((c) => c.id).sort()).toEqual([pub.id]);

    // Member (give bob a membership): sees both.
    addMember(db, group.id, bob, "member");
    const memberRes = await signedRequest(app, bob, "GET", `/api/groups/${group.id}/channels`);
    expect(memberRes.status).toBe(200);
    const memberItems = ((await memberRes.json()) as { items: Channel[] }).items;
    expect(memberItems.map((c) => c.id).sort()).toEqual([pub.id, priv.id].sort());
  });
});

// ---------------------------------------------------------------------------
// GET single — tier rules
// ---------------------------------------------------------------------------

describe("GET /api/groups/{groupId}/channels/{channelId} (§5.5, tier)", () => {
  test("public channel readable by non-member → 200", async () => {
    const { app } = freshApp("chan-get-public");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    const res = await app.request(`/api/groups/${group.id}/channels/${channel.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Channel;
    expect(() => ChannelSchema.parse(body)).not.toThrow();
  });

  test("private channel: non-member → 403, member → 200", async () => {
    const { app, db } = freshApp("chan-get-private");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "private" });

    // Non-member (authenticated) → 403.
    const forbidden = await signedRequest(
      app,
      bob,
      "GET",
      `/api/groups/${group.id}/channels/${channel.id}`,
    );
    expect(forbidden.status).toBe(403);

    // Member → 200.
    addMember(db, group.id, bob, "member");
    const ok = await signedRequest(
      app,
      bob,
      "GET",
      `/api/groups/${group.id}/channels/${channel.id}`,
    );
    expect(ok.status).toBe(200);
  });

  test("missing channel → 404", async () => {
    const { app } = freshApp("chan-get-missing");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const res = await app.request(`/api/groups/${group.id}/channels/chn_nope`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE + group-delete cascade
// ---------------------------------------------------------------------------

describe("DELETE /api/groups/{groupId}/channels/{channelId} (§5.5)", () => {
  test("non-manager → 403; manager → 204", async () => {
    const { app, db } = freshApp("chan-delete");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text" });
    addMember(db, group.id, bob, "member");

    const forbidden = await signedRequest(
      app,
      bob,
      "DELETE",
      `/api/groups/${group.id}/channels/${channel.id}`,
    );
    expect(forbidden.status).toBe(403);

    const ok = await signedRequest(
      app,
      alice,
      "DELETE",
      `/api/groups/${group.id}/channels/${channel.id}`,
    );
    expect(ok.status).toBe(204);

    const after = await app.request(`/api/groups/${group.id}/channels/${channel.id}`);
    expect(after.status).toBe(404);
  });

  test("deleting the parent group cascades to its channels", async () => {
    const { app } = freshApp("chan-cascade");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    // Sanity: the channel exists.
    const before = await app.request(`/api/groups/${group.id}/channels/${channel.id}`);
    expect(before.status).toBe(200);

    // Delete the group (owner).
    const del = await signedRequest(app, alice, "DELETE", `/api/groups/${group.id}`);
    expect(del.status).toBe(204);

    // The group is gone (404) and so is its channel (404 — group missing).
    const groupGone = await app.request(`/api/groups/${group.id}/channels/${channel.id}`);
    expect(groupGone.status).toBe(404);
  });
});
