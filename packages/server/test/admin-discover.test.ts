/**
 * Admin-curated discover allowlist (Forumall extension, not OFSCP).
 *
 * Discover is no longer an auto-list of every `discoverable`-tier channel: it is
 * an admin-curated allowlist of GROUPS. A discoverable channel surfaces only when
 * its owning group has been explicitly featured by a provider admin. This suite
 * covers:
 *
 *  - a discoverable channel does NOT appear in `GET /api/discover` until its
 *    group is featured; appears once featured; gone again once unfeatured;
 *  - non-admin → 403 on every `/api/admin/discover*` route;
 *  - `GET /api/admin/discover` partitions groups into featured vs candidate
 *    (candidates = groups with a discoverable channel, not already featured);
 *  - featuring a non-existent group → 404.
 *
 * Drives the app in-process via `app.request(...)`, reusing the discovery-feed
 * test's seeding helpers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Channel,
  DiscoverResponseSchema,
  type Group,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-admin-discover-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string, env: Record<string, string> = {}) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
    ENABLE_DISCOVER_FEED: "true",
    ...env,
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

async function createGroup(app: App, s: Signer, body: Record<string, unknown>): Promise<Group> {
  const res = await signedRequest(app, s, "POST", "/api/groups", body);
  expect(res.status).toBe(201);
  return (await res.json()) as Group;
}

async function createChannel(
  app: App,
  s: Signer,
  groupId: string,
  body: Record<string, unknown>,
): Promise<Channel> {
  const res = await signedRequest(app, s, "POST", `/api/groups/${groupId}/channels`, body);
  expect(res.status).toBe(201);
  return (await res.json()) as Channel;
}

async function discoverChannels(app: App): Promise<string[]> {
  const res = await app.request("/api/discover");
  expect(res.status).toBe(200);
  const body = DiscoverResponseSchema.parse(await res.json());
  return body.items.map((i) => i.channel);
}

interface AdminDiscoverResponse {
  featured: Group[];
  candidates: Group[];
}

// ---------------------------------------------------------------------------
// The first registered account is the implicit instance admin.
// ---------------------------------------------------------------------------

describe("admin discover curation", () => {
  test("a discoverable channel is hidden until its group is featured, then shown, then hidden again", async () => {
    const { app } = freshApp("curate-lifecycle");
    const admin = await registerUserWithKey(app, "alice"); // first user → admin
    const group = await createGroup(app, admin, { name: "G", tier: "public" });
    const disc = await createChannel(app, admin, group.id, {
      type: "text",
      tier: "discoverable",
      name: "Disc",
    });

    // Not featured yet → empty feed.
    expect(await discoverChannels(app)).toEqual([]);

    // Feature the group via the admin route.
    const put = await signedRequest(app, admin, "PUT", `/api/admin/discover/${group.id}`);
    expect(put.status).toBe(200);

    // Now the discoverable channel surfaces.
    expect(await discoverChannels(app)).toEqual([disc.id]);

    // Unfeature → gone again.
    const del = await signedRequest(app, admin, "DELETE", `/api/admin/discover/${group.id}`);
    expect(del.status).toBe(204);
    expect(await discoverChannels(app)).toEqual([]);
  });

  test("a discoverable channel in a non-featured group does NOT appear when another group is featured", async () => {
    const { app } = freshApp("curate-isolation");
    const admin = await registerUserWithKey(app, "alice");

    const featuredGroup = await createGroup(app, admin, { name: "Featured", tier: "public" });
    const featuredChan = await createChannel(app, admin, featuredGroup.id, {
      type: "text",
      tier: "discoverable",
    });
    const otherGroup = await createGroup(app, admin, { name: "Other", tier: "public" });
    const otherChan = await createChannel(app, admin, otherGroup.id, {
      type: "text",
      tier: "discoverable",
    });

    const put = await signedRequest(app, admin, "PUT", `/api/admin/discover/${featuredGroup.id}`);
    expect(put.status).toBe(200);

    const channels = await discoverChannels(app);
    expect(channels).toContain(featuredChan.id);
    expect(channels).not.toContain(otherChan.id);
  });

  test("GET /api/admin/discover partitions featured vs candidate groups", async () => {
    const { app } = freshApp("curate-partition");
    const admin = await registerUserWithKey(app, "alice");

    // A group WITH a discoverable channel — eligible candidate.
    const withDisc = await createGroup(app, admin, { name: "WithDisc", tier: "public" });
    await createChannel(app, admin, withDisc.id, { type: "text", tier: "discoverable" });

    // A group with only a non-discoverable channel — NOT a candidate.
    const noDisc = await createGroup(app, admin, { name: "NoDisc", tier: "public" });
    await createChannel(app, admin, noDisc.id, { type: "text", tier: "public" });

    // Before featuring: withDisc is a candidate, featured is empty.
    let res = await signedRequest(app, admin, "GET", "/api/admin/discover");
    expect(res.status).toBe(200);
    let body = (await res.json()) as AdminDiscoverResponse;
    expect(body.featured.map((g) => g.id)).toEqual([]);
    expect(body.candidates.map((g) => g.id)).toContain(withDisc.id);
    expect(body.candidates.map((g) => g.id)).not.toContain(noDisc.id);

    // Feature it → moves from candidate to featured.
    const put = await signedRequest(app, admin, "PUT", `/api/admin/discover/${withDisc.id}`);
    expect(put.status).toBe(200);

    res = await signedRequest(app, admin, "GET", "/api/admin/discover");
    body = (await res.json()) as AdminDiscoverResponse;
    expect(body.featured.map((g) => g.id)).toEqual([withDisc.id]);
    expect(body.candidates.map((g) => g.id)).not.toContain(withDisc.id);
  });

  test("featuring a non-existent group is rejected (404)", async () => {
    const { app } = freshApp("curate-missing");
    const admin = await registerUserWithKey(app, "alice");
    const res = await signedRequest(app, admin, "PUT", "/api/admin/discover/grp_does_not_exist");
    expect(res.status).toBe(404);
  });

  test("non-admin → 403 on all /api/admin/discover* routes", async () => {
    const { app } = freshApp("curate-403");
    await registerUserWithKey(app, "alice"); // first user → admin (not used below)
    const bob = await registerUserWithKey(app, "bob"); // second user → NOT admin
    const group = await createGroup(app, bob, { name: "G", tier: "public" });

    const get = await signedRequest(app, bob, "GET", "/api/admin/discover");
    expect(get.status).toBe(403);

    const put = await signedRequest(app, bob, "PUT", `/api/admin/discover/${group.id}`);
    expect(put.status).toBe(403);

    const del = await signedRequest(app, bob, "DELETE", `/api/admin/discover/${group.id}`);
    expect(del.status).toBe(403);
  });
});
