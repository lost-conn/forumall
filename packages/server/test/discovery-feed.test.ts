/**
 * Known providers (§8.6) + discovery feed (§11.2) tests — both OPTIONAL/MAY.
 *
 * Covers the two config toggles and how they gate the endpoints AND the
 * discovery document's `capabilities.discovery` flags:
 *  - default config: `GET /api/providers` → 404, `GET /api/discover` → 404, and
 *    the discovery doc advertises `sharesKnownProviders:false` / `discoverFeed:false`;
 *  - `ENABLE_KNOWN_PROVIDERS=true`: seeded peers are listed (schema-valid) and
 *    the doc advertises `sharesKnownProviders:true`;
 *  - `ENABLE_DISCOVER_FEED=true`: only `discoverable`-tier channels are surfaced
 *    as pointers (with a non-authoritative sample), a non-discoverable channel is
 *    absent, the page shape is present, NO feed table exists, and the doc
 *    advertises `discoverFeed:true`;
 *  - `scrapeKnownProviders` merges a peer's `GET /api/providers` (two-provider
 *    harness).
 *
 * Drives each app in-process via `app.request(...)`, signing with the shared
 * `sign()` (same harness as `follows.test.ts`).
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
  type ProviderDiscovery,
  ProviderDiscoverySchema,
  ProvidersResponseSchema,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { featureGroup } from "../src/provider/discover-features.ts";
import { addKnownProvider, scrapeKnownProviders } from "../src/provider/known-providers.ts";
import { createMessage } from "../src/provider/messages.ts";
import { startFederation } from "./helpers/two-provider.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-discovery-feed-"));
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
    ...env,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db });
  return { app, config, db };
}

type App = ReturnType<typeof freshApp>["app"];
type Db = ReturnType<typeof freshApp>["db"];
type Cfg = ReturnType<typeof freshApp>["config"];

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

/**
 * Insert a channel message directly via the store. Message create is WS-only on
 * the wire (no REST POST), so tests seed the sample preview through
 * `createMessage` — same pattern the follows test uses for direct membership
 * inserts.
 */
function seedMessage(
  db: Db,
  config: Cfg,
  groupId: string,
  channelId: string,
  author: string,
  text: string,
): void {
  createMessage(db, config, {
    channelId,
    groupId,
    author,
    type: "message",
    content: { text, mime: "text/plain" },
  });
}

async function fetchDiscoveryDoc(app: App): Promise<ProviderDiscovery> {
  const res = await app.request("/.well-known/ofscp-provider");
  expect(res.status).toBe(200);
  return ProviderDiscoverySchema.parse(await res.json());
}

// ---------------------------------------------------------------------------
// Default config — both features OFF
// ---------------------------------------------------------------------------

describe("default config — known providers + discover feed OFF", () => {
  test("GET /api/providers → 404, GET /api/discover → 404", async () => {
    const { app } = freshApp("default-off");
    const providers = await app.request("/api/providers");
    expect(providers.status).toBe(404);
    const discover = await app.request("/api/discover");
    expect(discover.status).toBe(404);
  });

  test("discovery doc advertises sharesKnownProviders:false, discoverFeed:false", async () => {
    const { app } = freshApp("default-off-doc");
    const doc = await fetchDiscoveryDoc(app);
    expect(doc.capabilities?.discovery?.sharesKnownProviders).toBe(false);
    expect(doc.capabilities?.discovery?.discoverFeed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Known providers (§8.6) — ENABLE_KNOWN_PROVIDERS=true
// ---------------------------------------------------------------------------

describe("known providers enabled (§8.6)", () => {
  test("seeded peers are listed (schema-valid); doc shows sharesKnownProviders:true", async () => {
    const { app, db } = freshApp("known-on", { ENABLE_KNOWN_PROVIDERS: "true" });

    // Manual seeding is the baseline (§8.6).
    addKnownProvider(db, "b.test", "Provider B");
    addKnownProvider(db, "c.test");

    const res = await app.request("/api/providers");
    expect(res.status).toBe(200);
    const body = ProvidersResponseSchema.parse(await res.json());
    const domains = body.providers.map((p) => p.domain).sort();
    expect(domains).toEqual(["b.test", "c.test"]);
    const b = body.providers.find((p) => p.domain === "b.test");
    expect(b?.name).toBe("Provider B");
    expect(b?.addedAt).toBeTruthy();
    expect(body.metadata).toEqual([]);

    const doc = await fetchDiscoveryDoc(app);
    expect(doc.capabilities?.discovery?.sharesKnownProviders).toBe(true);
  });

  test("adding the same peer twice is idempotent (no dup)", async () => {
    const { app, db } = freshApp("known-idempotent", { ENABLE_KNOWN_PROVIDERS: "true" });
    const first = addKnownProvider(db, "b.test");
    const second = addKnownProvider(db, "b.test");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const res = await app.request("/api/providers");
    const body = ProvidersResponseSchema.parse(await res.json());
    expect(body.providers.filter((p) => p.domain === "b.test").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Discovery feed (§11.2) — ENABLE_DISCOVER_FEED=true
// ---------------------------------------------------------------------------

describe("discovery feed enabled (§11.2)", () => {
  test("only discoverable channels surface as pointers; doc shows discoverFeed:true", async () => {
    const { app, db, config } = freshApp("discover-on", { ENABLE_DISCOVER_FEED: "true" });
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });

    const disc = await createChannel(app, alice, group.id, {
      type: "text",
      tier: "discoverable",
      name: "Disc",
    });
    // A non-discoverable channel that MUST NOT appear in the feed.
    const pub = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    // A message for the (non-authoritative) sample preview.
    seedMessage(db, config, group.id, disc.id, alice.actor, "hello discoverable");

    // Discover is now an admin-curated allowlist of GROUPS: nothing surfaces
    // until the owning group is featured by an admin.
    expect(
      (await DiscoverResponseSchema.parse(await (await app.request("/api/discover")).json())).items
        .length,
    ).toBe(0);
    featureGroup(db, group.id, "alice");

    const res = await app.request("/api/discover");
    expect(res.status).toBe(200);
    const body = DiscoverResponseSchema.parse(await res.json());

    const channels = body.items.map((i) => i.channel);
    expect(channels).toContain(disc.id);
    expect(channels).not.toContain(pub.id);
    expect(body.items.length).toBe(1);

    const item = body.items[0];
    expect(item?.provider).toBe(DOMAIN);
    expect(item?.groupId).toBe(group.id);
    expect(item?.sample?.content?.text).toBe("hello discoverable");

    // Page shape present (no nextCursor since only one item).
    expect(body.page).toBeDefined();
    expect(body.page.nextCursor).toBeUndefined();

    const doc = await fetchDiscoveryDoc(app);
    expect(doc.capabilities?.discovery?.discoverFeed).toBe(true);

    // No feed is stored: items are pointers compiled at read time. The
    // admin-curated allowlist table (`discover_features`) is an allowlist of
    // featured GROUPS, not a stored feed of pointers — it is the only "discover"
    // table permitted here.
    const tables = db.sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    expect(tables.some((t) => t.includes("feed"))).toBe(false);
    expect(tables.filter((t) => t.includes("discover"))).toEqual(["discover_features"]);
  });

  test("pagination: limit=1 yields a nextCursor that returns the next item", async () => {
    const { app, db } = freshApp("discover-paging", { ENABLE_DISCOVER_FEED: "true" });
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const c1 = await createChannel(app, alice, group.id, { type: "text", tier: "discoverable" });
    const c2 = await createChannel(app, alice, group.id, { type: "text", tier: "discoverable" });
    // Feature the owning group so its discoverable channels surface (admin allowlist).
    featureGroup(db, group.id, "alice");

    const page1 = DiscoverResponseSchema.parse(
      await (await app.request("/api/discover?limit=1")).json(),
    );
    expect(page1.items.length).toBe(1);
    expect(page1.page.nextCursor).toBeTruthy();

    const next = encodeURIComponent(page1.page.nextCursor as string);
    const page2 = DiscoverResponseSchema.parse(
      await (await app.request(`/api/discover?limit=1&cursor=${next}`)).json(),
    );
    expect(page2.items.length).toBe(1);

    // The two pages cover both channels with no overlap.
    const seen = new Set([...page1.items, ...page2.items].map((i) => i.channel));
    expect(seen).toEqual(new Set([c1.id, c2.id]));
  });
});

// ---------------------------------------------------------------------------
// scrapeKnownProviders (§8.6) — two-provider harness
// ---------------------------------------------------------------------------

describe("scrapeKnownProviders merges a peer's list (§8.6)", () => {
  test("scraping B (which shares C) records both B and C on A", async () => {
    const fed = startFederation(tmp, {
      domainA: "a.test",
      domainB: "b.test",
      envB: { ENABLE_KNOWN_PROVIDERS: "true" },
    });
    try {
      // B shares a list containing peer C.
      addKnownProvider(fed.b.db, "c.test", "Provider C");

      // A scrapes B's GET /api/providers via the injected federation fetch.
      const added = await scrapeKnownProviders(
        fed.a.db,
        fed.a.config,
        "b.test",
        fed.a.federationFetch,
      );

      // A now knows both B (the seed peer) and C (listed by B), not itself.
      expect(added.sort()).toEqual(["b.test", "c.test"]);
      const res = await fed.a.app.request("/api/providers");
      // A has the feature OFF, so it 404s — but the rows were still recorded.
      expect(res.status).toBe(404);

      const rows = fed.a.db.sqlite
        .query<{ domain: string }, []>("SELECT domain FROM known_providers ORDER BY domain")
        .all()
        .map((r) => r.domain);
      expect(rows).toEqual(["b.test", "c.test"]);
    } finally {
      fed.stop();
    }
  });
});
