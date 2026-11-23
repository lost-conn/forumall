/**
 * Canonical actors / provider authorities (OFSCP §2.2) and the §8 deny list on
 * ALL outbound requests.
 *
 * One provider (`providera.test`) with `evil.example` on its deny list and a
 * spy `federationFetch` that records every outbound request. Each test spells
 * the denied provider some other way (`evil.example.`, `EVIL.example:443`, …)
 * and asserts the provider refuses it — and never touches the network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  canonicalActor,
  canonicalAuthority,
  deriveDmId,
  generateKeyPair,
  sign,
  signProvider,
} from "@forumall/shared";

import { MessageSchema } from "@forumall/shared";
import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { requireProviderSignature } from "../src/http/signature.ts";
import {
  type FederationFetch,
  signedProviderFetch,
  withFederationPolicy,
} from "../src/provider/federation/http.ts";
import { scrapeKnownProviders } from "../src/provider/known-providers.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";
const DENIED = "evil.example";
/** Other spellings of the denied provider — each must be treated as `evil.example`. */
const DENIED_SPELLINGS = [`${DENIED}.`, "EVIL.example:443", `${DENIED}:443`, `${DENIED}.:443`];

/**
 * Spellings that a URL parser resolves to (or that smuggle) some real host but
 * are not canonical authorities (review of #23): leading-zero ports, legacy
 * IPv4, expanded IPv6, userinfo, path/query, empty labels, junk ports.
 */
const ALIAS_AUTHORITIES = [
  "a.test:0443",
  "a.test:00443",
  "0x01020304",
  "[0:0:0:0:0:0:0:1]",
  "x@a.test",
  "a.test/x?",
  "a..test",
  ".a.test",
  "a.test:abc",
  // Unparseable by the URL parser — must fail closed, never pass as canonical.
  "a.test:65536",
  "999.1.1.1",
  "4294967296",
];

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-canon-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A spy transport: records every outbound request, answers 500 (never reached in a pass). */
function spyFetch(): { fetch: FederationFetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (_domain, request) => {
      calls.push(request.url);
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    },
  };
}

let appSeq = 0;
function freshApp() {
  const name = `app-${appSeq++}`;
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
    FEDERATION_DENY: DENIED,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const spy = spyFetch();
  const app = createApp(config, { testOnlySkipReplayWarmup: true, db, federationFetch: spy.fetch });
  app.post("/api/test/provider-ping", requireProviderSignature(), (c) => c.json({ ok: true }));
  return { app, config, db, spy };
}
type App = ReturnType<typeof freshApp>["app"];

async function registerUserWithKey(app: App, handle: string) {
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
type Signer = Awaited<ReturnType<typeof registerUserWithKey>>;

function signedJson(app: App, s: Signer, method: string, path: string, body: unknown) {
  const raw = JSON.stringify(body);
  const { headers } = sign({ ...s, authority: DOMAIN, method, path, body: raw });
  return app.request(path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: raw,
  });
}

describe("canonical helpers (§2.2)", () => {
  test("every spelling of a provider canonicalizes to one authority", () => {
    for (const s of DENIED_SPELLINGS) expect(canonicalAuthority(s)).toBe(DENIED);
    expect(canonicalAuthority("bücher.test")).toBe("xn--bcher-kva.test");
    expect(canonicalAuthority("a.test:8443")).toBe("a.test:8443");
    expect(canonicalActor("Alice@A.test:443")).toBe("alice@a.test");
    expect(canonicalActor("alice")).toBeNull();
  });
});

describe("aliased / junk authorities are never canonical (review of #23)", () => {
  test("strict isCanonicalAuthority rejects every alias spelling", async () => {
    const { isCanonicalAuthority, isCanonicalActor } = await import("@forumall/shared");
    for (const a of ALIAS_AUTHORITIES) {
      expect(isCanonicalAuthority(a)).toBe(false);
      expect(isCanonicalActor(`alice@${a}`)).toBe(false);
    }
    expect(canonicalAuthority("a.test:0443")).toBe("a.test");
    expect(canonicalAuthority("0x01020304")).toBe("1.2.3.4");
    expect(canonicalAuthority("[0:0:0:0:0:0:0:1]")).toBe("[::1]");
    for (const ok of ["a.test", "a.test:8443", "localhost:3000", "[::1]:8443", "1.2.3.4"]) {
      expect(isCanonicalAuthority(ok)).toBe(true);
    }
  });

  test("X-OFSCP-Actor / X-OFSCP-Provider on an alias authority → 401, no network", async () => {
    const { app, spy } = freshApp();
    const { privateKey } = generateKeyPair();
    for (const a of ALIAS_AUTHORITIES) {
      const actorReq = sign({
        actor: `mallory@${a}`,
        keyId: "k1",
        privateKey,
        authority: DOMAIN,
        method: "GET",
        path: "/api/auth/device-keys",
      });
      const r1 = await app.request("/api/auth/device-keys", {
        method: "GET",
        headers: actorReq.headers,
      });
      expect(r1.status).toBe(401);
      const provReq = signProvider({
        provider: a,
        keyId: "k1",
        privateKey,
        authority: DOMAIN,
        method: "POST",
        path: "/api/test/provider-ping",
        body: "",
      });
      const r2 = await app.request("/api/test/provider-ping", {
        method: "POST",
        headers: provReq.headers,
      });
      expect(r2.status).toBe(401);
    }
    expect(spy.calls).toEqual([]);
  });

  test("alias authorities in body `with`/`to` → 400; as follow/webhook/push hosts → 400", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    const keys = {
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    };
    for (const a of [...ALIAS_AUTHORITIES, `${DOMAIN}:0443`]) {
      const counterparty = `bob@${a}`;
      // Any dmId: the canonical check precedes the dmId check.
      const withRes = await signedJson(app, alice, "PUT", "/api/me/dms/dm_x", {
        with: counterparty,
      });
      expect(withRes.status).toBe(400);
      const toRes = await signedJson(app, alice, "POST", "/api/federation/dms/dm_x/messages", {
        to: counterparty,
        clientMessageId: "c1",
        content: { mime: "text/plain", text: "hi" },
      });
      expect(toRes.status).toBe(400);
      // `https://a.test/x?/…` is a genuine URI on host `a.test` (path `/x?/…`),
      // not an alias, so it is only meaningful in actor/header position.
      if (a.includes("/")) continue;
      for (const [path, body] of [
        ["/api/me/follows", { channel: `https://${a}/api/groups/g/channels/c` }],
        [
          "/api/notifications/endpoints",
          { type: "webhook", target: `https://${a}/hook`, events: ["message.created"] },
        ],
        ["/api/push/subscribe", { endpoint: `https://${a}/push/1`, keys }],
      ] as const) {
        const res = await signedJson(app, alice, "POST", path, body);
        expect(res.status).toBe(400);
      }
    }
  });

  test("alice@{our domain}:0443 cannot authenticate as a distinct actor", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    // Correctly signed with alice's real key; only the domain spelling differs.
    for (const actor of [`alice@${DOMAIN}:0443`, `alice@${DOMAIN}:00443`]) {
      const { headers } = sign({
        actor,
        keyId: alice.keyId,
        privateKey: alice.privateKey,
        authority: DOMAIN,
        method: "GET",
        path: "/api/auth/device-keys",
      });
      const res = await app.request("/api/auth/device-keys", { method: "GET", headers });
      expect(res.status).toBe(401);
    }
  });

  test("a remote actor on an alias of its home authority is refused even when the alias would serve valid keys", async () => {
    // A transport that would happily serve mallory's genuine keys document for
    // ANY host — so only the canonical-form gate can stop the alias identity.
    const { publicKey, privateKey } = generateKeyPair();
    const calls: string[] = [];
    const servesKeys: FederationFetch = (_d, request) => {
      calls.push(request.url);
      return Promise.resolve(
        Response.json({
          actor: "mallory@b.test",
          keys: [
            {
              key_id: "k1",
              algorithm: "Ed25519",
              public_key: publicKey,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          cache_until: "2099-01-01T00:00:00Z",
        }),
      );
    };
    const base = loadConfig({
      DATA_DIR: tmp,
      DB_PATH: join(tmp, `alias-${appSeq++}.sqlite`),
      WEB_DIR: join(tmp, "alias-web"),
      DOMAIN,
    });
    const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
    const db = openDb(config.dbPath);
    migrate(db);
    const app = createApp(config, {
      testOnlySkipReplayWarmup: true,
      db,
      federationFetch: servesKeys,
    });
    const req = (actor: string) => {
      const { headers } = sign({
        actor,
        keyId: "k1",
        privateKey,
        authority: DOMAIN,
        method: "GET",
        path: "/api/auth/device-keys",
      });
      return app.request("/api/auth/device-keys", { method: "GET", headers });
    };
    // Control: the canonical identity verifies against the served keys.
    expect((await req("mallory@b.test")).status).not.toBe(401);
    calls.length = 0;
    for (const alias of ["mallory@b.test:0443", "mallory@b.test:00443"]) {
      expect((await req(alias)).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  test("known-provider scrape never records junk or aliased entries", async () => {
    const { config, db } = freshApp();
    const peerList: FederationFetch = () =>
      Promise.resolve(
        Response.json({
          providers: [
            { domain: "c.test", addedAt: "2026-01-01T00:00:00Z" },
            { domain: "C.test:0443", addedAt: "2026-01-01T00:00:00Z" },
            { domain: "a.test/x?", addedAt: "2026-01-01T00:00:00Z" },
            { domain: "x@d.test", addedAt: "2026-01-01T00:00:00Z" },
            { domain: "a..test", addedAt: "2026-01-01T00:00:00Z" },
          ],
          metadata: [],
        }),
      );
    const added = await scrapeKnownProviders(db, config, "b.test", peerList);
    expect(added.sort()).toEqual(["b.test", "c.test"]);
  });
});

describe("privacy lists store canonical actors only (review of #23)", () => {
  test("a user-URI entry is converted to its actor; other URI shapes → 400", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    const ok = await signedJson(app, alice, "PUT", "/api/me/privacy", {
      denyList: ["https://b.test/api/users/mallory"],
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { denyList: string[] }).denyList).toEqual(["mallory@b.test"]);
    for (const bad of [
      "https://b.test/api/groups/g",
      "https://B.test/api/users/mallory",
      "https://b.test:0443/api/users/mallory",
      "https://b.test/api/users/mallory?x=1",
      "https://x@b.test/api/users/mallory",
      "https://b.test/api/users/Mallory",
    ]) {
      const res = await signedJson(app, alice, "PUT", "/api/me/privacy", { denyList: [bad] });
      expect(res.status).toBe(400);
    }
  });
});

describe("inbound identities naming a denied provider are refused before any fetch", () => {
  test("X-OFSCP-Provider spelled non-canonically → 401, no network", async () => {
    const { app, spy } = freshApp();
    const { privateKey } = generateKeyPair();
    for (const provider of DENIED_SPELLINGS) {
      const { headers } = signProvider({
        provider,
        keyId: "k1",
        privateKey,
        authority: DOMAIN,
        method: "POST",
        path: "/api/test/provider-ping",
        body: "",
      });
      const res = await app.request("/api/test/provider-ping", { method: "POST", headers });
      expect(res.status).toBe(401);
    }
    expect(spy.calls).toEqual([]);
  });

  test("canonical X-OFSCP-Provider of the denied provider → 403, no network", async () => {
    const { app, spy } = freshApp();
    const { privateKey } = generateKeyPair();
    const { headers } = signProvider({
      provider: DENIED,
      keyId: "k1",
      privateKey,
      authority: DOMAIN,
      method: "POST",
      path: "/api/test/provider-ping",
      body: "",
    });
    const res = await app.request("/api/test/provider-ping", { method: "POST", headers });
    expect(res.status).toBe(403);
    expect(spy.calls).toEqual([]);
  });

  test("X-OFSCP-Actor on a non-canonical spelling of the denied provider → 401, no key fetch", async () => {
    const { app, spy } = freshApp();
    const { privateKey } = generateKeyPair();
    for (const domain of DENIED_SPELLINGS) {
      const { headers } = sign({
        actor: `mallory@${domain}`,
        keyId: "k1",
        privateKey,
        authority: DOMAIN,
        method: "GET",
        path: "/api/auth/device-keys",
      });
      const res = await app.request("/api/auth/device-keys", { method: "GET", headers });
      expect(res.status).toBe(401);
    }
    expect(spy.calls).toEqual([]);
  });
});

describe("stored provider authorities: rejected if non-canonical, refused if denied", () => {
  test("follow of a channel URI on a spelling of the denied provider → 400 / 403", async () => {
    const { app, spy } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    for (const host of DENIED_SPELLINGS) {
      const res = await signedJson(app, alice, "POST", "/api/me/follows", {
        channel: `https://${host}/api/groups/grp_x/channels/chn_x`,
      });
      expect(res.status).toBe(400);
    }
    const denied = await signedJson(app, alice, "POST", "/api/me/follows", {
      channel: `https://${DENIED}/api/groups/grp_x/channels/chn_x`,
    });
    expect(denied.status).toBe(403);
    // A canonical, allowed remote channel is still followable.
    const ok = await signedJson(app, alice, "POST", "/api/me/follows", {
      channel: "https://b.test/api/groups/grp_x/channels/chn_x",
    });
    expect(ok.status).toBe(201);
    expect(spy.calls).toEqual([]);
  });

  test("notification webhook target on a spelling of the denied provider → 400 / 403", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    for (const host of DENIED_SPELLINGS) {
      const res = await signedJson(app, alice, "POST", "/api/notifications/endpoints", {
        type: "webhook",
        target: `https://${host}/hook`,
        events: ["message.created"],
      });
      expect(res.status).toBe(400);
    }
    const denied = await signedJson(app, alice, "POST", "/api/notifications/endpoints", {
      type: "webhook",
      target: `https://${DENIED}/hook`,
      events: ["message.created"],
    });
    expect(denied.status).toBe(403);
  });

  test("push endpoint on a spelling of the denied provider → 400 / 403", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    const keys = {
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    };
    const bad = await signedJson(app, alice, "POST", "/api/push/subscribe", {
      endpoint: `https://${DENIED}./push/1`,
      keys,
    });
    expect(bad.status).toBe(400);
    const denied = await signedJson(app, alice, "POST", "/api/push/subscribe", {
      endpoint: `https://${DENIED}/push/1`,
      keys,
    });
    expect(denied.status).toBe(403);
  });

  test("DM pointer `with` naming a non-canonical actor → 400", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    for (const counterparty of [`bob@${DENIED}.`, "bob@B.test", "Bob@b.test", "bob@b.test:443"]) {
      const dmId = deriveDmId(alice.actor, counterparty);
      const res = await signedJson(app, alice, "PUT", `/api/me/dms/${dmId}`, {
        with: counterparty,
      });
      expect(res.status).toBe(400);
    }
  });

  test("privacy allow/deny list entries must be canonical actors → 400", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    const bad = await signedJson(app, alice, "PUT", "/api/me/privacy", {
      denyList: [`mallory@${DENIED}.`],
    });
    expect(bad.status).toBe(400);
    const ok = await signedJson(app, alice, "PUT", "/api/me/privacy", {
      denyList: [`mallory@${DENIED}`],
    });
    expect(ok.status).toBe(200);
  });
});

describe("§8: no outbound request of any kind to a denied provider", () => {
  test("the outbound door refuses every spelling of a denied provider without fetching", async () => {
    const { config } = freshApp();
    const spy = spyFetch();
    const door = withFederationPolicy(config, spy.fetch);
    for (const host of [DENIED, ...DENIED_SPELLINGS]) {
      // Refused whether the denied host is the logical domain or only the URL authority.
      const a = await door(host, new Request(`https://${host}/.well-known/ofscp-provider`));
      expect(a.status).toBe(403);
      const b = await door("b.test", new Request(`https://${host}/api/x`, { method: "POST" }));
      expect(b.status).toBe(403);
    }
    expect(spy.calls).toEqual([]);
    // An allowed provider passes through.
    await door("b.test", new Request("https://b.test/api/x"));
    expect(spy.calls).toEqual(["https://b.test/api/x"]);
  });

  test("key (§4.6) and discovery (§3.1) fetches via the app's caches never reach a denied host", async () => {
    const { app, spy } = freshApp();
    for (const host of DENIED_SPELLINGS) {
      expect(await app.__userKeysCache.getActorKey(`mallory@${host}`, "k1")).toBeNull();
      expect(await app.__discoveryCache.getProviderKey(host, "k1")).toBeNull();
    }
    expect(spy.calls).toEqual([]);
  });

  test("signedProviderFetch / known-provider scrape refuse a denied host spelled differently", async () => {
    const { config, db } = freshApp();
    const spy = spyFetch();
    for (const host of DENIED_SPELLINGS) {
      const res = await signedProviderFetch(
        db,
        config,
        { method: "POST", url: `https://${host}/api/federation/dms/x/messages`, body: "{}" },
        spy.fetch,
      );
      expect(res.status).toBe(403);
      expect(await scrapeKnownProviders(db, config, host, spy.fetch)).toEqual([]);
    }
    expect(spy.calls).toEqual([]);
  });
});

describe("request vs. output validation failures (review of #23)", () => {
  test("a malformed REQUEST body → 400 (DM send, contacts)", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    const dm = await signedJson(app, alice, "POST", "/api/federation/dms/dm_x/messages", {
      clientMessageId: "c1",
      to: "bob@x@a.test",
      content: { mime: "text/plain", text: "hi" },
    });
    expect(dm.status).toBe(400);
    const contact = await signedJson(app, alice, "POST", "/api/me/contacts", { user: 42 });
    expect(contact.status).toBe(400);
    const body = (await contact.json()) as Record<string, unknown>;
    expect(body.errors).toBeUndefined(); // no zod internals leaked
  });

  test("a malformed reaction PUT body → 400, not 500", async () => {
    const { app } = freshApp();
    const alice = await registerUserWithKey(app, "alice");
    // The body is validated before the reaction is authorized, so any target works.
    const res = await signedJson(
      app,
      alice,
      "PUT",
      "/api/groups/grp_x/channels/chn_x/messages/msg_x/reactions/heart",
      { image: "http://not-https.example/x.png" },
    );
    expect(res.status).toBe(400);
  });

  test("a failed validation of the server's OWN output → 500, not 400", async () => {
    const { app } = freshApp();
    app.get("/api/test/bad-output", (c) => c.json(MessageSchema.parse({ id: 1 })));
    const res = await app.request("/api/test/bad-output");
    expect(res.status).toBe(500);
  });
});
