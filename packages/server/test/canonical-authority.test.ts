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
  const app = createApp(config, { db, federationFetch: spy.fetch });
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
