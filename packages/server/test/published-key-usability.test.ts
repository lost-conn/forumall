/**
 * Published keys are judged one by one (OFSCP §4.3.2, §4.3.3).
 *
 * In a keys response (§4.6) or `provider.publicKeys` of a discovery document
 * (§3.1, §8.1), an entry whose `public_key` is not a raw 32-byte Ed25519 key in
 * padded standard base64, or whose `algorithm` is not `Ed25519`, is ignored on
 * its own: the document stays valid and its other keys stay usable. A request
 * whose `X-OFSCP-Key-ID` names an ignored entry fails as for an unknown key: the
 * verifier re-fetches (§4.6), then answers `401`, or `503` + `Retry-After` when
 * that re-fetch fails or is rate-limited.
 *
 * Provider B (`b.test`, this app) verifies requests from `alice@a.test` and
 * from provider `a.test`, whose documents an injected transport serves.
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
const BAD_ID = "dk_bad";
const alice = generateKeyPair();

let tmp: string;
let n = 0;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-key-usability-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function config(domain: string): { config: Config; db: ReturnType<typeof openDb> } {
  n += 1;
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `p${n}.sqlite`),
    WEB_DIR: join(tmp, `p${n}-web`),
    DOMAIN: domain,
  });
  const db = openDb(base.dbPath);
  migrate(db);
  return { config: Object.freeze({ ...base, argon2: FAST_ARGON2 }), db };
}

/** Boot B with alice as a member of a private group; also mount a provider-signed probe. */
function boot(caches: {
  userKeysCache?: RemoteUserKeysCache;
  discoveryCache?: RemoteDiscoveryCache;
}) {
  const { config: cfg, db } = config(LOCAL);
  const app = createApp(cfg, { testOnlySkipReplayWarmup: true, db, ...caches });
  app.get("/api/provider-probe", requireProviderSignature(), (c) => c.json({ ok: true }));
  const group = createGroup(db, `owner@${LOCAL}`, { name: "secret", tier: "private" });
  addMember(db, group.id, ALICE);
  return { app, path: `/api/groups/${group.id}` };
}

type App = ReturnType<typeof boot>["app"];

/** A user-signed GET from alice@a.test naming `keyId`. */
function aliceGet(app: App, path: string, keyId = KEY_ID): Promise<Response> {
  const { headers } = sign({
    actor: ALICE,
    keyId,
    privateKey: alice.privateKey,
    authority: LOCAL,
    method: "GET",
    path,
  });
  return Promise.resolve(app.request(path, { method: "GET", headers }));
}

interface Entry {
  readonly key_id: string;
  readonly algorithm: string;
  readonly public_key: string;
}

const b64 = (bytes: number) => Buffer.from(new Uint8Array(bytes).fill(9)).toString("base64");
const aliceEntry: Entry = { key_id: KEY_ID, algorithm: "Ed25519", public_key: alice.publicKey };

/**
 * Published entries a v0.1 verifier cannot use. Each is a string, so every
 * document holding one is still schema-valid.
 */
const UNUSABLE: ReadonlyArray<[string, Omit<Entry, "key_id">]> = [
  ["a 16-byte key", { algorithm: "Ed25519", public_key: b64(16) }],
  ["a 33-byte key", { algorithm: "Ed25519", public_key: b64(33) }],
  [
    "a DER SubjectPublicKeyInfo (44 bytes)",
    {
      algorithm: "Ed25519",
      public_key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(alice.publicKey, "base64"),
      ]).toString("base64"),
    },
  ],
  ["an unpadded key", { algorithm: "Ed25519", public_key: alice.publicKey.replace(/=$/, "") }],
  ["a non-base64 string", { algorithm: "Ed25519", public_key: "not a key" }],
  ["an unsupported algorithm", { algorithm: "Ed448", public_key: alice.publicKey }],
  ["a differently cased algorithm", { algorithm: "ed25519", public_key: alice.publicKey }],
];

function keysDoc(keys: readonly Entry[]): Response {
  return Response.json({
    actor: ALICE,
    keys: keys.map((k) => ({ ...k, created_at: "2026-01-01T00:00:00Z" })),
    cache_until: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

/** A transport answering with `respond()` (switchable), counting calls. */
function transport(initial: () => Response) {
  let respond = initial;
  const calls: string[] = [];
  const fetch: FederationFetch = async (_domain, req) => {
    calls.push(req.url);
    return respond();
  };
  return {
    fetch,
    calls,
    answer: (r: () => Response) => {
      respond = r;
    },
  };
}

/** A user-keys cache over `t` with a controllable clock. */
function clockedUserKeys(t: ReturnType<typeof transport>) {
  let now = Date.now();
  const cache = new RemoteUserKeysCache({ federationFetch: t.fetch, now: () => now });
  return {
    cache,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function expectStatus(res: Response, status: number, errorCode: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { errorCode: string };
  expect(body.errorCode).toBe(errorCode);
}

describe("keys response (§4.6): an unusable entry is ignored, the rest stay usable", () => {
  for (const [name, bad] of UNUSABLE) {
    test(`${name} beside a good key → the good key verifies (200)`, async () => {
      const t = transport(() => keysDoc([{ key_id: BAD_ID, ...bad }, aliceEntry]));
      const { app, path } = boot({ userKeysCache: clockedUserKeys(t).cache });
      expect((await aliceGet(app, path)).status).toBe(200);
      expect(t.calls).toHaveLength(1);
    });

    test(`a request naming ${name} → 401, as an unknown key`, async () => {
      const t = transport(() => keysDoc([{ key_id: BAD_ID, ...bad }, aliceEntry]));
      const { app, path } = boot({ userKeysCache: clockedUserKeys(t).cache });
      await expectStatus(await aliceGet(app, path, BAD_ID), 401, "unauthorized");
    });
  }

  test("an unusable entry does not hide a usable one under the same key_id", async () => {
    const t = transport(() =>
      keysDoc([{ key_id: KEY_ID, algorithm: "Ed25519", public_key: b64(16) }, aliceEntry]),
    );
    const { app, path } = boot({ userKeysCache: clockedUserKeys(t).cache });
    expect((await aliceGet(app, path)).status).toBe(200);
  });

  test("naming an ignored entry re-fetches (it counts as absent), then 401", async () => {
    const t = transport(() => keysDoc([{ key_id: BAD_ID, ...b16() }, aliceEntry]));
    const clock = clockedUserKeys(t);
    const { app, path } = boot({ userKeysCache: clock.cache });
    expect((await aliceGet(app, path)).status).toBe(200); // caches the document
    expect(t.calls).toHaveLength(1);
    clock.advance(5_000); // past the per-actor re-fetch interval, inside cache_until
    await expectStatus(await aliceGet(app, path, BAD_ID), 401, "unauthorized");
    expect(t.calls).toHaveLength(2); // the cached document did not settle it: a re-fetch did
  });

  test("the re-fetch picks up the entry once it is published correctly → 200", async () => {
    const t = transport(() => keysDoc([{ key_id: BAD_ID, ...b16() }, aliceEntry]));
    const clock = clockedUserKeys(t);
    const { app, path } = boot({ userKeysCache: clock.cache });
    await expectStatus(await aliceGet(app, path, BAD_ID), 401, "unauthorized");
    t.answer(() =>
      keysDoc([{ key_id: BAD_ID, algorithm: "Ed25519", public_key: alice.publicKey }, aliceEntry]),
    );
    clock.advance(5_000);
    expect((await aliceGet(app, path, BAD_ID)).status).toBe(200);
  });

  test("naming an ignored entry when the re-fetch fails → 503 + Retry-After", async () => {
    const t = transport(() => keysDoc([{ key_id: BAD_ID, ...b16() }, aliceEntry]));
    const clock = clockedUserKeys(t);
    const { app, path } = boot({ userKeysCache: clock.cache });
    expect((await aliceGet(app, path)).status).toBe(200);
    t.answer(() => new Response("down", { status: 500 }));
    clock.advance(5_000);
    const res = await aliceGet(app, path, BAD_ID);
    await expectStatus(res, 503, "service_unavailable");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // The good key is still served from the unexpired cached document.
    expect((await aliceGet(app, path)).status).toBe(200);
  });

  test("naming an ignored entry when the re-fetch is rate-limited → 503 + Retry-After", async () => {
    const t = transport(() => keysDoc([{ key_id: BAD_ID, ...b16() }, aliceEntry]));
    const { app, path } = boot({ userKeysCache: clockedUserKeys(t).cache });
    expect((await aliceGet(app, path)).status).toBe(200);
    // Same instant: the per-actor interval has not passed, so no fetch may start.
    const res = await aliceGet(app, path, BAD_ID);
    await expectStatus(res, 503, "service_unavailable");
    expect(res.headers.get("retry-after")).toBe("1");
    expect(t.calls).toHaveLength(1);
  });
});

describe("discovery (§8.1): an unusable provider key is ignored, the rest stay usable", () => {
  /** A real discovery document + signing key for provider `a.test`. */
  async function remoteProvider() {
    const { config: cfg, db } = config(REMOTE);
    const key = getProviderSigningKey(db);
    const remote = createApp(cfg, { testOnlySkipReplayWarmup: true, db });
    const doc = (await (await remote.request("/.well-known/ofscp-provider")).json()) as {
      provider: { publicKeys: Entry[] } & Record<string, unknown>;
    } & Record<string, unknown>;
    return { doc, key };
  }

  function withKeys(
    doc: Awaited<ReturnType<typeof remoteProvider>>["doc"],
    extra: readonly Entry[],
  ) {
    return {
      ...doc,
      provider: { ...doc.provider, publicKeys: [...extra, ...doc.provider.publicKeys] },
    };
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

  for (const [name, bad] of UNUSABLE) {
    test(`${name} beside the real key → the real key verifies; naming it → 401`, async () => {
      const { doc, key } = await remoteProvider();
      const served = withKeys(doc, [{ key_id: "psk-bad", ...bad }]);
      let now = Date.now();
      const t = transport(() => Response.json(served));
      const discoveryCache = new RemoteDiscoveryCache({ federationFetch: t.fetch, now: () => now });
      const { app } = boot({ discoveryCache });
      expect((await providerGet(app, key)).status).toBe(200);
      now += 5_000;
      await expectStatus(
        await providerGet(app, { keyId: "psk-bad", privateKey: key.privateKey }),
        401,
        "unauthorized",
      );
      expect(t.calls).toHaveLength(2); // naming the ignored entry re-fetched
    });
  }

  test("a provider whose only key is unusable → 401, never 503", async () => {
    const { doc, key } = await remoteProvider();
    const only = {
      ...doc,
      provider: {
        ...doc.provider,
        publicKeys: [{ key_id: key.keyId, algorithm: "Ed448", public_key: b64(57) }],
      },
    };
    const discoveryCache = new RemoteDiscoveryCache({
      federationFetch: transport(() => Response.json(only)).fetch,
    });
    const { app } = boot({ discoveryCache });
    await expectStatus(await providerGet(app, key), 401, "unauthorized");
  });
});

/** An unusable (16-byte) Ed25519 entry body. */
function b16(): Omit<Entry, "key_id"> {
  return { algorithm: "Ed25519", public_key: b64(16) };
}
