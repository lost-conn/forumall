/**
 * §4.5 step 6 status codes for REMOTE signers (spec §4.6, §8.1, §8 Outbound
 * requests) — why a key did not resolve decides the answer:
 *
 *  - no matching key (a valid 200 without it, an empty list, a 404) → 401;
 *  - the keys could not be fetched (DNS failure or timeout, 5xx, 429, invalid
 *    body, a document for someone else) → 503 `service_unavailable` +
 *    `Retry-After`, answered promptly (one egress deadline, DNS included);
 *  - the outbound-request rules refuse the fetch (a private address) → 401;
 *  - federation policy denies the signer's provider → 403, before any fetch;
 *  - only an UNEXPIRED cache entry counts: expired + fetch failure → 503,
 *    unexpired + fetch failure → still accepted.
 *
 * Provider B (`b.test`, this app) verifies requests from `alice@a.test` (and
 * provider `a.test`) whose home provider is simulated by an injected transport.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, sign, signProvider } from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { requireProviderSignature } from "../src/http/signature.ts";
import { RemoteDiscoveryCache } from "../src/provider/federation/discovery-cache.ts";
import { type Resolver, guardedFetch } from "../src/provider/federation/egress-guard.ts";
import type { FederationFetch } from "../src/provider/federation/http.ts";
import { RemoteUserKeysCache } from "../src/provider/federation/user-keys-cache.ts";
import { createGroup } from "../src/provider/groups.ts";
import { addMember } from "../src/provider/membership.ts";
import { getProviderSigningKey } from "../src/provider/signing-key.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const LOCAL = "b.test";
const REMOTE = "a.test";
const ALICE = `alice@${REMOTE}`;
const KEY_ID = "dk_alice";
const alice = generateKeyPair();

let tmp: string;
let n = 0;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-signer-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface BootOptions {
  /** Transport the app's (default) caches use. */
  readonly federationFetch?: FederationFetch;
  /** Injected caches (for a controllable clock). */
  readonly userKeysCache?: RemoteUserKeysCache;
  readonly discoveryCache?: RemoteDiscoveryCache;
  readonly env?: Record<string, string>;
}

/** Boot B with alice as a member of a private group; return the app + group path. */
function boot(opts: BootOptions) {
  n += 1;
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `b${n}.sqlite`),
    WEB_DIR: join(tmp, `b${n}-web`),
    DOMAIN: LOCAL,
    ...opts.env,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, {
    testOnlySkipReplayWarmup: true,
    db,
    ...(opts.federationFetch ? { federationFetch: opts.federationFetch } : {}),
    ...(opts.userKeysCache ? { userKeysCache: opts.userKeysCache } : {}),
    ...(opts.discoveryCache ? { discoveryCache: opts.discoveryCache } : {}),
  });
  const group = createGroup(db, `owner@${LOCAL}`, { name: "secret", tier: "private" });
  addMember(db, group.id, ALICE);
  return { app, path: `/api/groups/${group.id}` };
}

type App = ReturnType<typeof boot>["app"];

/** A user-signed GET from alice@a.test (signed with `privateKey`). */
function aliceGet(app: App, path: string, privateKey = alice.privateKey): Promise<Response> {
  const { headers } = sign({
    actor: ALICE,
    keyId: KEY_ID,
    privateKey,
    authority: LOCAL,
    method: "GET",
    path,
  });
  return Promise.resolve(app.request(path, { method: "GET", headers }));
}

/** A §4.6 keys response for `actor` holding `keys`. */
function keysDoc(
  keys: Array<{ keyId: string; publicKey: string }>,
  opts: { actor?: string; cacheUntilMs?: number } = {},
): Response {
  return Response.json({
    actor: opts.actor ?? ALICE,
    keys: keys.map((k) => ({
      key_id: k.keyId,
      algorithm: "Ed25519",
      public_key: k.publicKey,
      created_at: "2026-01-01T00:00:00Z",
    })),
    cache_until: new Date(opts.cacheUntilMs ?? Date.now() + 3_600_000).toISOString(),
  });
}

const aliceKeys = () => keysDoc([{ keyId: KEY_ID, publicKey: alice.publicKey }]);

/** A transport answering every request with `respond()`, counting calls. */
function transport(respond: (req: Request) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetch: FederationFetch = async (_domain, req) => {
    calls.push(req.url);
    return respond(req);
  };
  return { fetch, calls };
}

/** A transport that runs the real egress guard with `resolve` (never reaches a network). */
function guardedTransport(resolve: Resolver, timeoutMs = 200): FederationFetch {
  return (_domain, req) =>
    guardedFetch(req, {
      resolve,
      timeoutMs,
      fetch: async () => {
        throw new Error("the guard must stop this request before it is sent");
      },
    });
}

async function expectProblem(res: Response, status: number, errorCode: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  const body = (await res.json()) as { errorCode: string };
  expect(body.errorCode).toBe(errorCode);
}

async function expect503(res: Response) {
  await expectProblem(res, 503, "service_unavailable");
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter) && retryAfter >= 1).toBe(true);
}

describe("remote actor: keys resolve → accepted", () => {
  test("a valid keys response holding the key → 200", async () => {
    const { app, path } = boot({ federationFetch: transport(aliceKeys).fetch });
    expect((await aliceGet(app, path)).status).toBe(200);
  });
});

describe("remote actor: DNS (egress) outcomes", () => {
  test("a resolver that never settles → 503 promptly (one deadline covers DNS)", async () => {
    const { app, path } = boot({
      federationFetch: guardedTransport(() => new Promise<string[]>(() => {}), 200),
    });
    const started = performance.now();
    const res = await aliceGet(app, path);
    const elapsed = performance.now() - started;
    await expect503(res);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("a resolver that rejects (NXDOMAIN) → 503", async () => {
    const { app, path } = boot({
      federationFetch: guardedTransport(async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND a.test"), { code: "ENOTFOUND" });
      }),
    });
    await expect503(await aliceGet(app, path));
  });

  test("a resolver returning a private address → 401 (outbound rules refuse, never 503)", async () => {
    const { app, path } = boot({ federationFetch: guardedTransport(async () => ["10.0.0.7"]) });
    await expectProblem(await aliceGet(app, path), 401, "unauthorized");
  });
});

describe("remote actor: fetch failures → 503", () => {
  const cases: Array<[string, () => Response]> = [
    ["a 500", () => new Response("boom", { status: 500 })],
    ["a 429", () => new Response(null, { status: 429, headers: { "retry-after": "5" } })],
    ["a 3xx (redirects are never followed)", () => new Response(null, { status: 302 })],
    ["another 4xx", () => new Response(null, { status: 403 })],
    ["invalid JSON", () => new Response("{not json", { status: 200 })],
    ["a schema-invalid body", () => Response.json({ hello: "world" })],
    [
      "a response for a different handle",
      () => keysDoc([{ keyId: KEY_ID, publicKey: alice.publicKey }], { actor: `bob@${REMOTE}` }),
    ],
    [
      "a response for the same handle at another provider",
      () => keysDoc([{ keyId: KEY_ID, publicKey: alice.publicKey }], { actor: "alice@other.test" }),
    ],
  ];
  for (const [name, respond] of cases) {
    test(`${name} → 503`, async () => {
      const { app, path } = boot({ federationFetch: transport(respond).fetch });
      await expect503(await aliceGet(app, path));
    });
  }

  test("a transport error → 503", async () => {
    const { app, path } = boot({
      federationFetch: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });
    await expect503(await aliceGet(app, path));
  });
});

describe("remote actor: no matching key → 401", () => {
  test("404 → 401", async () => {
    const { app, path } = boot({
      federationFetch: transport(() => new Response(null, { status: 404 })).fetch,
    });
    await expectProblem(await aliceGet(app, path), 401, "unauthorized");
  });

  test("an empty keys list → 401", async () => {
    const { app, path } = boot({ federationFetch: transport(() => keysDoc([])).fetch });
    await expectProblem(await aliceGet(app, path), 401, "unauthorized");
  });

  test("a keys list without the key id → 401", async () => {
    const other = generateKeyPair();
    const t = transport(() => keysDoc([{ keyId: "dk_other", publicKey: other.publicKey }]));
    const { app, path } = boot({ federationFetch: t.fetch });
    await expectProblem(await aliceGet(app, path), 401, "unauthorized");
    expect(t.calls).toHaveLength(1); // fetched once: no redundant re-fetch
  });

  test("a just-fetched key that does not verify → 401 without a second fetch", async () => {
    const t = transport(aliceKeys);
    const { app, path } = boot({ federationFetch: t.fetch });
    const forged = generateKeyPair();
    await expectProblem(await aliceGet(app, path, forged.privateKey), 401, "unauthorized");
    expect(t.calls).toHaveLength(1);
  });
});

describe("remote actor: only an unexpired cache entry counts (§4.6)", () => {
  /** A cache with a controllable clock over a switchable transport. */
  function clockedApp() {
    let now = Date.now();
    let respond: () => Response = aliceKeys;
    const t = transport(() => respond());
    const userKeysCache = new RemoteUserKeysCache({ federationFetch: t.fetch, now: () => now });
    const { app, path } = boot({ userKeysCache });
    return {
      app,
      path,
      calls: t.calls,
      advance: (ms: number) => {
        now += ms;
      },
      failWith: (r: () => Response) => {
        respond = r;
      },
    };
  }

  test("an unexpired entry + a fetch failure → still accepted", async () => {
    const env = clockedApp();
    expect((await aliceGet(env.app, env.path)).status).toBe(200);
    env.failWith(() => new Response(null, { status: 503 }));
    env.advance(60_000); // well inside the 1 h cache window
    expect((await aliceGet(env.app, env.path)).status).toBe(200);
    expect(env.calls).toHaveLength(1); // served from the cache, no fetch
  });

  test("an expired entry + a fetch failure → 503, never the stale key", async () => {
    const env = clockedApp();
    expect((await aliceGet(env.app, env.path)).status).toBe(200);
    env.failWith(() => new Response(null, { status: 500 }));
    env.advance(3_600_000 + 1_000); // past cache_until (and the 1 h cap)
    await expect503(await aliceGet(env.app, env.path));
    expect(env.calls).toHaveLength(2);
  });

  test("a cached key that fails to verify + a failed re-fetch → 503 (cannot finally reject)", async () => {
    const env = clockedApp();
    expect((await aliceGet(env.app, env.path)).status).toBe(200);
    env.failWith(() => new Response(null, { status: 500 }));
    const rotated = generateKeyPair();
    await expect503(await aliceGet(env.app, env.path, rotated.privateKey));
    expect(env.calls).toHaveLength(2);
  });
});

describe("remote actor: federation policy → 403 before any fetch", () => {
  test("a denied signer's provider → 403 forbidden, no fetch", async () => {
    const t = transport(aliceKeys);
    const { app, path } = boot({ federationFetch: t.fetch, env: { FEDERATION_DENY: REMOTE } });
    await expectProblem(await aliceGet(app, path), 403, "forbidden");
    expect(t.calls).toHaveLength(0);
  });
});

describe("remote provider (§8.1) discovery outcomes", () => {
  /** A real discovery document + signing key for provider `a.test`. */
  async function remoteProvider() {
    n += 1;
    const base = loadConfig({
      DATA_DIR: tmp,
      DB_PATH: join(tmp, `a${n}.sqlite`),
      WEB_DIR: join(tmp, `a${n}-web`),
      DOMAIN: REMOTE,
    });
    const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
    const db = openDb(config.dbPath);
    migrate(db);
    const key = getProviderSigningKey(db);
    const remote = createApp(config, { testOnlySkipReplayWarmup: true, db });
    const doc = (await (await remote.request("/.well-known/ofscp-provider")).json()) as {
      provider: { domain: string };
    };
    return { doc, key };
  }

  async function bootProviderRoute(federationFetch: FederationFetch) {
    const discoveryCache = new RemoteDiscoveryCache({ federationFetch });
    const { app } = boot({ discoveryCache });
    app.get("/api/provider-probe", requireProviderSignature(), (c) => c.json({ ok: true }));
    return app;
  }

  function providerGet(app: App, key: { keyId: string; privateKey: string }): Promise<Response> {
    const path = "/api/provider-probe";
    const { headers } = signProvider({
      provider: REMOTE,
      keyId: key.keyId,
      privateKey: key.privateKey,
      authority: LOCAL,
      method: "GET",
      path,
    });
    return Promise.resolve(app.request(path, { method: "GET", headers }));
  }

  test("a valid discovery document → accepted", async () => {
    const { doc, key } = await remoteProvider();
    const app = await bootProviderRoute(transport(() => Response.json(doc)).fetch);
    expect((await providerGet(app, key)).status).toBe(200);
  });

  test("a discovery document naming another provider → 503", async () => {
    const { doc, key } = await remoteProvider();
    const forged = { ...doc, provider: { ...doc.provider, domain: "evil.test" } };
    const app = await bootProviderRoute(transport(() => Response.json(forged)).fetch);
    await expect503(await providerGet(app, key));
  });

  test("a 404 for discovery is a fetch failure → 503", async () => {
    const { key } = await remoteProvider();
    const app = await bootProviderRoute(transport(() => new Response(null, { status: 404 })).fetch);
    await expect503(await providerGet(app, key));
  });

  test("a hung resolver → 503 promptly", async () => {
    const { key } = await remoteProvider();
    const app = await bootProviderRoute(guardedTransport(() => new Promise<string[]>(() => {})));
    const started = performance.now();
    await expect503(await providerGet(app, key));
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  test("a private resolved address → 401", async () => {
    const { key } = await remoteProvider();
    const app = await bootProviderRoute(guardedTransport(async () => ["127.0.0.1"]));
    await expectProblem(await providerGet(app, key), 401, "unauthorized");
  });
});
