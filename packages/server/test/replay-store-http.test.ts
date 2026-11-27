/**
 * The provider-wide replay store over HTTP (§4.5 steps 4 and 7).
 *
 *  - A full store fails closed: a request that verifies but whose nonce cannot
 *    be recorded gets `503` + `Retry-After`, never a `200` with a replayable
 *    nonce; a request that does not verify still gets its `401` (a nonce is
 *    recorded only after the signature verifies).
 *  - A replayed provider-signed (§8.1) request gets `401`, like a replayed
 *    user-signed one.
 *  - Two concurrent copies of one request that both pass step 4 while the
 *    signer's key is being fetched: exactly one is served, the other is
 *    refused `401` by the re-check after step 7.
 *
 * Provider B (`b.test`, this app) serves alice@a.test and provider `a.test`
 * through an injected transport.
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
import type { FederationFetch } from "../src/provider/federation/http.ts";
import { RemoteUserKeysCache } from "../src/provider/federation/user-keys-cache.ts";
import { createGroup } from "../src/provider/groups.ts";
import { addMember } from "../src/provider/membership.ts";
import { InMemoryNonceStore, type NonceStore, nonceKeyId } from "../src/provider/nonce-store.ts";
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
  tmp = mkdtempSync(join(tmpdir(), "forumall-replay-http-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function openProvider(domain: string) {
  n += 1;
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `p${n}.sqlite`),
    WEB_DIR: join(tmp, `p${n}-web`),
    DOMAIN: domain,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  return { config, db };
}

/** Boot B (alice a member of a private group, a provider-signed probe mounted). */
function boot(
  federationFetch: FederationFetch,
  nonceStore: NonceStore,
  userKeysCache?: RemoteUserKeysCache,
) {
  const { config, db } = openProvider(LOCAL);
  const app = createApp(config, {
    db,
    federationFetch,
    nonceStore,
    ...(userKeysCache ? { userKeysCache } : {}),
  });
  app.get("/api/provider-probe", requireProviderSignature(), (c) => c.json({ ok: true }));
  const group = createGroup(db, `owner@${LOCAL}`, { name: "secret", tier: "private" });
  addMember(db, group.id, ALICE);
  return { app, path: `/api/groups/${group.id}` };
}

type App = ReturnType<typeof boot>["app"];

const keysDoc = () =>
  Response.json({
    actor: ALICE,
    keys: [
      {
        key_id: KEY_ID,
        algorithm: "Ed25519",
        public_key: alice.publicKey,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    cache_until: new Date(Date.now() + 3_600_000).toISOString(),
  });

/** Signed headers for a GET from alice@a.test (a fresh nonce each call). */
function aliceHeaders(path: string, privateKey = alice.privateKey): Record<string, string> {
  return sign({
    actor: ALICE,
    keyId: KEY_ID,
    privateKey,
    authority: LOCAL,
    method: "GET",
    path,
  }).headers;
}

function get(app: App, path: string, headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(app.request(path, { method: "GET", headers }));
}

async function expectProblem(res: Response, status: number, errorCode: string) {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { errorCode: string }).errorCode).toBe(errorCode);
}

describe("a full replay store fails closed (§4.5)", () => {
  test("a verified request whose nonce cannot be recorded → 503 + Retry-After", async () => {
    const store = new InMemoryNonceStore({ startedAt: 0, maxEntries: 1 });
    const { app, path } = boot(async () => keysDoc(), store);
    expect((await get(app, path, aliceHeaders(path))).status).toBe(200); // fills the store

    const full = await get(app, path, aliceHeaders(path));
    await expectProblem(full, 503, "service_unavailable");
    expect(Number(full.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  test("a request that does not verify still gets 401, not the full-store 503", async () => {
    const store = new InMemoryNonceStore({ startedAt: 0, maxEntries: 1 });
    // No re-fetch interval: the forged request's forced re-fetch (§4.6) runs
    // and finds the same key, so the answer is the plain 401.
    const federationFetch: FederationFetch = async () => keysDoc();
    const userKeysCache = new RemoteUserKeysCache({ federationFetch, refetchIntervalMs: 0 });
    const { app, path } = boot(federationFetch, store, userKeysCache);
    expect((await get(app, path, aliceHeaders(path))).status).toBe(200);
    const forged = aliceHeaders(path, generateKeyPair().privateKey);
    await expectProblem(await get(app, path, forged), 401, "unauthorized");
  });

  test("the refused request's nonce is not recorded (the 503 burns nothing)", async () => {
    const store = new InMemoryNonceStore({ startedAt: 0, maxEntries: 1 });
    const { app, path } = boot(async () => keysDoc(), store);
    const first = aliceHeaders(path);
    expect((await get(app, path, first)).status).toBe(200);
    const second = aliceHeaders(path);
    expect((await get(app, path, second)).status).toBe(503);
    const ns = nonceKeyId("actor", KEY_ID);
    expect(store.has(ns, first["X-OFSCP-Nonce"] ?? "")).toBe(true);
    expect(store.has(ns, second["X-OFSCP-Nonce"] ?? "")).toBe(false);
  });
});

describe("a replayed provider-signed request → 401 (§4.5 step 4, §8.1)", () => {
  test("the first copy is served, an exact replay is refused", async () => {
    const remote = openProvider(REMOTE);
    const key = getProviderSigningKey(remote.db);
    const remoteApp = createApp(remote.config, { testOnlySkipReplayWarmup: true, db: remote.db });
    const doc = await (await remoteApp.request("/.well-known/ofscp-provider")).json();
    const { app } = boot(async () => Response.json(doc), new InMemoryNonceStore({ startedAt: 0 }));
    const path = "/api/provider-probe";
    const { headers } = signProvider({
      provider: REMOTE,
      keyId: key.keyId,
      privateKey: key.privateKey,
      authority: LOCAL,
      method: "GET",
      path,
    });
    expect((await get(app, path, headers)).status).toBe(200);
    await expectProblem(await get(app, path, headers), 401, "unauthorized");
  });
});

describe("concurrent copies of one request (§4.5: atomic re-check after step 7)", () => {
  test("both pass step 4 while the key is fetched; exactly one is served", async () => {
    // Release the key fetch only once both copies have passed step 4.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = new InMemoryNonceStore({ startedAt: 0 });
    let step4 = 0;
    const store: NonceStore = {
      get startedAt() {
        return inner.startedAt;
      },
      now: () => inner.now(),
      has: (keyId, nonce) => {
        step4 += 1;
        if (step4 === 2) release(); // both copies have checked step 4
        return inner.has(keyId, nonce);
      },
      remember: (keyId, nonce, ttl) => inner.remember(keyId, nonce, ttl),
    };
    const { app, path } = boot(async () => {
      await gate;
      return keysDoc();
    }, store);

    const headers = aliceHeaders(path);
    const [a, b] = await Promise.all([get(app, path, headers), get(app, path, headers)]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const refused = a.status === 401 ? a : b;
    await expectProblem(refused, 401, "unauthorized");
  });
});
