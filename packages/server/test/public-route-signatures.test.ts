/**
 * Signed requests to public routes (OFSCP §4.5 "Anonymous viewers", §8
 * *Authorization*).
 *
 * §8 applies the inbound allow/deny policy to every SIGNED request on every
 * route, public ones included (discovery, the keys endpoint, …), after §4.5
 * steps 1–5 and before any key or discovery fetch; an UNSIGNED request carries
 * no provider identity and is answered as for anyone. §4.5: any `X-OFSCP-*`
 * header makes a request signed and subject to the full checks (`401` when they
 * fail), while a request with none of them on an anonymous-reader route is an
 * anonymous viewer, never `401`.
 *
 * Covers, with a deny list set:
 *  - every public route answers an unsigned request as usual;
 *  - a user-signed request from a denied provider → `403` on every route that
 *    accepts unsigned callers (public probes, unsigned-by-design auth routes,
 *    anonymous-reader routes), with no outbound fetch;
 *  - a provider-signed request from a denied provider → `403` on the public
 *    probes, which accept either signer;
 *  - steps 1–5 win over the policy (stale timestamp → `401`, digest → `400`),
 *    and a `403`'d request's nonce is not recorded;
 *  - a partial or invalid signature on a public / anonymous-reader route → `401`;
 *  - during the replay warm-up (§4.5 "Restarts") an unsigned probe is still
 *    served while a signed one gets `503`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  HEADER,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signProvider,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import type { FederationFetch } from "../src/provider/federation/http.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";
const DENIED = "evil.example";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-public-sig-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let appSeq = 0;
function freshApp(opts: { warmup?: boolean; policy?: Record<string, string> } = {}) {
  const name = `app-${appSeq++}`;
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
    ...(opts.policy ?? { FEDERATION_DENY: DENIED }),
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const calls: string[] = [];
  const federationFetch: FederationFetch = (_domain, request) => {
    calls.push(request.url);
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  };
  const app = createApp(config, {
    testOnlySkipReplayWarmup: opts.warmup !== true,
    db,
    federationFetch,
  });
  return { app, calls };
}
type App = ReturnType<typeof freshApp>["app"];

interface Signer {
  actor: string;
  keyId: string;
  privateKey: string;
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
  return { actor: `${handle}@${DOMAIN}`, keyId, privateKey };
}

/** A route to probe: method + path, and a JSON body for POSTs. */
interface Route {
  method: "GET" | "POST";
  path: string;
}

/** Sends `route` with `headers` (and `{}` as the body of a POST). */
async function send(app: App, route: Route, headers: Record<string, string>): Promise<Response> {
  const body = route.method === "POST" ? "{}" : undefined;
  return await app.request(route.path, {
    method: route.method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/** Headers of `route` signed by `signer` (body `{}` for a POST). */
function actorHeaders(
  signer: Signer,
  route: Route,
  extra: { timestamp?: string; nonce?: string } = {},
): Record<string, string> {
  return sign({
    ...signer,
    authority: DOMAIN,
    method: route.method,
    path: route.path,
    ...(route.method === "POST" ? { body: "{}" } : {}),
    ...extra,
  }).headers;
}

/** A user of the denied provider, with a key nobody can resolve. */
function deniedActor(): Signer {
  return {
    actor: `mallory@${DENIED}`,
    keyId: "dk_mallory",
    privateKey: generateKeyPair().privateKey,
  };
}

function deniedProviderHeaders(route: Route): Record<string, string> {
  return signProvider({
    provider: DENIED,
    keyId: "pk_evil",
    privateKey: generateKeyPair().privateKey,
    authority: DOMAIN,
    method: route.method,
    path: route.path,
    ...(route.method === "POST" ? { body: "{}" } : {}),
  }).headers;
}

async function expectProblem(res: Response, status: number, errorCode: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect(((await res.json()) as { errorCode: string }).errorCode).toBe(errorCode);
}

/** Public routes that serve an unsigned request with `200`. */
const PUBLIC_200: Route[] = [
  { method: "GET", path: "/.well-known/ofscp-provider" },
  { method: "GET", path: "/.well-known/ofscp/users/alice/keys" },
  { method: "GET", path: "/api/tiers" },
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/problems/not_found" },
  { method: "GET", path: "/api/provider" },
  { method: "GET", path: "/api/push/public-key" },
];

/**
 * Routes that need no caller but whose unsigned answer is not a plain 200 here
 * (feature off, unknown id, invalid body) or would touch the network.
 */
const PUBLIC_OTHER: Route[] = [
  { method: "GET", path: "/api/providers" },
  { method: "GET", path: "/api/discover" },
  { method: "GET", path: "/api/media/med_unknown" },
  { method: "GET", path: "/api/push/_egress-check" },
  { method: "POST", path: "/api/auth/register" },
  { method: "POST", path: "/api/auth/login" },
  { method: "POST", path: "/api/auth/device-keys" },
  { method: "POST", path: "/api/invites/inv_unknown/guest" },
];

/** §4.5 anonymous-reader routes (user-signed or unsigned). */
function anonymousReaderRoutes(groupId: string, channelId: string, messageId: string): Route[] {
  const ch = `/api/groups/${groupId}/channels/${channelId}`;
  return [
    { method: "GET", path: "/api/users/alice/profile" },
    { method: "GET", path: "/api/users/alice/presence" },
    { method: "GET", path: "/api/users/alice/groups" },
    { method: "GET", path: `/api/groups/${groupId}` },
    { method: "GET", path: `/api/groups/${groupId}/channels` },
    { method: "GET", path: ch },
    { method: "GET", path: `${ch}/messages` },
    { method: "GET", path: `${ch}/messages/${messageId}/replies` },
  ];
}

/** Alice, a public group + channel she owns, and one message in it. */
async function seed(app: App) {
  const alice = await registerUserWithKey(app, "alice");
  const post = async (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    const { headers } = sign({ ...alice, authority: DOMAIN, method: "POST", path, body: raw });
    const res = await app.request(path, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: raw,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const group = await post("/api/groups", { name: "g", tier: "public" });
  const channel = await post(`/api/groups/${group.id}/channels`, {
    type: "text",
    name: "general",
    tier: "public",
  });
  const message = await post(`/api/groups/${group.id}/channels/${channel.id}/messages`, {
    type: "message",
    content: { text: "hi", mime: "text/plain" },
  });
  return { alice, groupId: group.id, channelId: channel.id, messageId: message.id };
}

describe("unsigned requests are answered regardless of the deny list (§8)", () => {
  test("public routes and anonymous-reader routes → 200", async () => {
    const { app, calls } = freshApp();
    const { groupId, channelId, messageId } = await seed(app);
    for (const route of [...PUBLIC_200, ...anonymousReaderRoutes(groupId, channelId, messageId)]) {
      const res = await send(app, route, {});
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 200 });
    }
    expect(calls).toEqual([]);
  });
});

describe("a signed request naming a denied provider → 403 on every public route (§8)", () => {
  test("user-signed: public probes, unsigned-by-design routes, anonymous readers", async () => {
    const { app, calls } = freshApp();
    const { groupId, channelId, messageId } = await seed(app);
    const mallory = deniedActor();
    const routes = [
      ...PUBLIC_200,
      ...PUBLIC_OTHER,
      ...anonymousReaderRoutes(groupId, channelId, messageId),
    ];
    for (const route of routes) {
      const res = await send(app, route, actorHeaders(mallory, route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 403 });
      expect(((await res.json()) as { errorCode: string }).errorCode).toBe("forbidden");
    }
    // Refused before any key fetch (§4.6 "no fetch is allowed").
    expect(calls).toEqual([]);
  });

  test("provider-signed: public probes and unsigned-by-design routes", async () => {
    const { app, calls } = freshApp();
    for (const route of [...PUBLIC_200, ...PUBLIC_OTHER]) {
      const res = await send(app, route, deniedProviderHeaders(route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 403 });
      expect(((await res.json()) as { errorCode: string }).errorCode).toBe("forbidden");
    }
    // Refused before any discovery fetch (§8.1 step 2).
    expect(calls).toEqual([]);
  });

  test("§4.5 steps 1–5 win over the policy, and a 403'd nonce is not recorded", async () => {
    const { app } = freshApp();
    const mallory = deniedActor();
    const route: Route = { method: "GET", path: "/.well-known/ofscp-provider" };

    const stale = rfc3339Timestamp(new Date(Date.now() - 3_600_000));
    await expectProblem(
      await send(app, route, actorHeaders(mallory, route, { timestamp: stale })),
      401,
      "unauthorized",
    );

    const badDigest = { ...actorHeaders(mallory, route), [HEADER.CONTENT_DIGEST]: "AAAA" };
    await expectProblem(await send(app, route, badDigest), 400, "bad_request");

    // The same signed request twice: still 403, never a 401 replay.
    const headers = actorHeaders(mallory, route);
    await expectProblem(await send(app, route, headers), 403, "forbidden");
    await expectProblem(await send(app, route, headers), 403, "forbidden");
  });
});

describe("a signed request that fails §4.5 → 401, never anonymous (§4.5)", () => {
  test("a partial signature header set → 401 on public and anonymous-reader routes", async () => {
    const { app } = freshApp();
    const { groupId, channelId, messageId } = await seed(app);
    for (const route of [...PUBLIC_200, ...anonymousReaderRoutes(groupId, channelId, messageId)]) {
      for (const header of [HEADER.NONCE, HEADER.ACTOR, HEADER.PROVIDER]) {
        const res = await send(app, route, { [header]: "x" });
        expect({ path: route.path, header, status: res.status }).toEqual({
          path: route.path,
          header,
          status: 401,
        });
      }
    }
  });

  test("an invalid signature → 401 on public and anonymous-reader routes", async () => {
    const { app } = freshApp();
    const { alice, groupId, channelId, messageId } = await seed(app);
    const forged: Signer = { ...alice, privateKey: generateKeyPair().privateKey };
    for (const route of [...PUBLIC_200, ...anonymousReaderRoutes(groupId, channelId, messageId)]) {
      const res = await send(app, route, actorHeaders(forged, route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 401 });
    }
  });

  test("a valid local signature is accepted on public routes", async () => {
    const { app } = freshApp();
    const { alice } = await seed(app);
    for (const route of PUBLIC_200) {
      const res = await send(app, route, actorHeaders(alice, route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 200 });
    }
  });
});

describe("the provider's own authority is exempt from its policy (§8)", () => {
  test("an allow list that omits this provider still serves its own signed users", async () => {
    const { app } = freshApp({ policy: { FEDERATION_ALLOW: "friend.example" } });
    const { alice, groupId, channelId, messageId } = await seed(app);
    for (const route of [...PUBLIC_200, ...anonymousReaderRoutes(groupId, channelId, messageId)]) {
      const res = await send(app, route, actorHeaders(alice, route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 200 });
    }
    // …while an actor of a provider not on the allow list is refused.
    const route: Route = { method: "GET", path: "/api/tiers" };
    await expectProblem(
      await send(app, route, actorHeaders(deniedActor(), route)),
      403,
      "forbidden",
    );
  });
});

describe("replay warm-up (§4.5 Restarts)", () => {
  test("an unsigned probe is served during warm-up; a signed one gets 503", async () => {
    const { app } = freshApp({ warmup: true });
    const alice = await registerUserWithKey(app, "alice");
    for (const route of PUBLIC_200) {
      expect((await send(app, route, {})).status).toBe(200);
      const signed = await send(app, route, actorHeaders(alice, route));
      expect(signed.status).toBe(503);
      expect(signed.headers.get("retry-after")).not.toBeNull();
    }
  });
});
