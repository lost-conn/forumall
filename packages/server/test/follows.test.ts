/**
 * Follows tests (spec §7.6).
 *
 * A follow is a POINTER: the provider stores only which channels a user follows
 * and MUST NOT compile or store a feed. These tests cover the follow-list
 * lifecycle over the signed `/api/me/follows` endpoints, the local-channel
 * access check (public → ok, private non-member → 403, unknown → 404), a remote
 * channel URI stored as a pointer without a remote access check, the idempotent
 * follow/unfollow semantics, and an assertion that NO server-side feed table or
 * endpoint exists (the store holds only pointers).
 *
 * Drives the app in-process via `app.request(...)`, signing with the shared
 * `sign()` (same harness as `channels.test.ts`). Argon2id cost is reduced
 * (TEST-ONLY) so register stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Channel,
  type Follow,
  FollowsResponseSchema,
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
  tmp = mkdtempSync(join(tmpdir(), "forumall-follows-"));
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
  handle: string;
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
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}`, handle };
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

/** Insert a membership row directly (membership card owns the real join flow). */
function addMember(db: Db, groupId: string, signer: Signer, role: string): void {
  db.drizzle
    .insert(groupMembers)
    .values({ groupId, user: signer.actor, role, joinedAt: Date.now() })
    .run();
}

async function listFollows(app: App, who: Signer): Promise<Follow[]> {
  const res = await signedRequest(app, who, "GET", "/api/me/follows");
  expect(res.status).toBe(200);
  const body = await res.json();
  // The response MUST validate against the shared schema.
  const parsed = FollowsResponseSchema.parse(body);
  return parsed.follows;
}

// ---------------------------------------------------------------------------
// Local follow + listing
// ---------------------------------------------------------------------------

describe("follow a local public channel (§7.6)", () => {
  test("accessible public channel → 201 Follow; appears in the list", async () => {
    const { app } = freshApp("follows-local-public");
    // alice owns a public group with a public channel; bob is a non-member who
    // can still read/follow a public channel.
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const pub = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    const res = await signedRequest(app, bob, "POST", "/api/me/follows", {
      channel: pub.id,
      groupId: group.id,
    });
    expect(res.status).toBe(201);
    const follow = (await res.json()) as Follow;
    expect(follow.channel).toBe(pub.id);
    expect(follow.groupId).toBe(group.id);

    const list = await listFollows(app, bob);
    expect(list.length).toBe(1);
    expect(list[0]?.channel).toBe(pub.id);
  });

  test("idempotent: following the same channel again returns the existing follow, no dup", async () => {
    const { app } = freshApp("follows-idempotent");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const pub = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    const first = await signedRequest(app, alice, "POST", "/api/me/follows", { channel: pub.id });
    expect(first.status).toBe(201);
    const firstFollow = (await first.json()) as Follow;

    const second = await signedRequest(app, alice, "POST", "/api/me/follows", { channel: pub.id });
    // Already-followed → existing entry returned with 200 (not a duplicate, not an error).
    expect(second.status).toBe(200);
    const secondFollow = (await second.json()) as Follow;
    expect(secondFollow.createdAt).toBe(firstFollow.createdAt);

    // Exactly one row.
    const list = await listFollows(app, alice);
    expect(list.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Access check on follow
// ---------------------------------------------------------------------------

describe("local channel access check (§7.6)", () => {
  test("private channel the user is NOT a member of → 403; nothing stored", async () => {
    const { app } = freshApp("follows-private-403");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const priv = await createChannel(app, alice, group.id, { type: "text", tier: "private" });

    const res = await signedRequest(app, bob, "POST", "/api/me/follows", { channel: priv.id });
    expect(res.status).toBe(403);

    // Nothing was stored.
    expect((await listFollows(app, bob)).length).toBe(0);
  });

  test("private channel a member CAN follow → 201", async () => {
    const { app, db } = freshApp("follows-private-member");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const priv = await createChannel(app, alice, group.id, { type: "text", tier: "private" });
    addMember(db, group.id, bob, "member");

    const res = await signedRequest(app, bob, "POST", "/api/me/follows", { channel: priv.id });
    expect(res.status).toBe(201);
  });

  test("unknown local channel → 404", async () => {
    const { app } = freshApp("follows-unknown-404");
    const alice = await registerUserWithKey(app, "alice");

    const res = await signedRequest(app, alice, "POST", "/api/me/follows", { channel: "chn_nope" });
    expect(res.status).toBe(404);
    expect((await listFollows(app, alice)).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Remote channel pointer
// ---------------------------------------------------------------------------

describe("remote channel follow (§7.6)", () => {
  test("foreign-host channel URI → stored as a pointer (201), no remote access check", async () => {
    const { app } = freshApp("follows-remote");
    const alice = await registerUserWithKey(app, "alice");
    const remote = "https://remote.example/api/groups/grp_x/channels/chn_blog";

    const res = await signedRequest(app, alice, "POST", "/api/me/follows", { channel: remote });
    expect(res.status).toBe(201);
    const follow = (await res.json()) as Follow;
    expect(follow.channel).toBe(remote);

    const list = await listFollows(app, alice);
    expect(list.some((f) => f.channel === remote)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unfollow
// ---------------------------------------------------------------------------

describe("unfollow (§7.6)", () => {
  test("DELETE a followed channel → 204; gone from the list", async () => {
    const { app } = freshApp("follows-delete");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const pub = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    await signedRequest(app, alice, "POST", "/api/me/follows", { channel: pub.id });
    expect((await listFollows(app, alice)).length).toBe(1);

    const del = await signedRequest(
      app,
      alice,
      "DELETE",
      `/api/me/follows/${encodeURIComponent(pub.id)}`,
    );
    expect(del.status).toBe(204);

    expect((await listFollows(app, alice)).length).toBe(0);
  });

  test("DELETE a non-followed channel is still 204 (idempotent)", async () => {
    const { app } = freshApp("follows-delete-idempotent");
    const alice = await registerUserWithKey(app, "alice");

    const del = await signedRequest(
      app,
      alice,
      "DELETE",
      `/api/me/follows/${encodeURIComponent("chn_never")}`,
    );
    expect(del.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Pointers only — no server-side feed
// ---------------------------------------------------------------------------

describe("no server-side feed (§7.6)", () => {
  test("the store holds only follow pointers — no feed table exists", async () => {
    const { db } = freshApp("follows-no-feed");
    const tables = db.sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);

    // The follow pointer table exists...
    expect(tables).toContain("follows");
    // ...and there is NO compiled-feed table of any kind.
    expect(tables.some((t) => t.includes("feed"))).toBe(false);
  });

  test("there is no feed-compilation endpoint", async () => {
    const { app } = freshApp("follows-no-feed-endpoint");
    const alice = await registerUserWithKey(app, "alice");

    // No /api/me/feed (or similar) endpoint is mounted — it 404s.
    const res = await signedRequest(app, alice, "GET", "/api/me/feed");
    expect(res.status).toBe(404);
  });
});
