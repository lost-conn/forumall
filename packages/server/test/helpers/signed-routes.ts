/**
 * Shared fixtures for the tests that send signed requests to every kind of
 * route (OFSCP §4.5 "Anonymous viewers", §8 *Authorization*):
 * `public-route-signatures.test.ts` and `provider-signed-routes.test.ts`.
 *
 * {@link freshApp} boots a provider (`providera.test`, deny list
 * `evil.example`) whose federation transport records every outbound request
 * and whose replay store records every `remember`, so a test can assert that a
 * request was answered with no discovery/key fetch and no nonce recorded.
 */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  HEADER,
  generateKeyPair,
  sign,
  signProvider,
} from "@forumall/shared";

import { createApp } from "../../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../../src/config.ts";
import { openDb } from "../../src/db/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import type { FederationFetch } from "../../src/provider/federation/http.ts";
import { InMemoryNonceStore, type NonceStore } from "../../src/provider/nonce-store.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
export const DOMAIN = "providera.test";
export const DENIED = "evil.example";
/** A provider the default policy permits (nothing is listed but the deny entry). */
export const PERMITTED = "friend.example";

/**
 * Creates a temp dir for the calling test file (removed after it) and returns
 * a getter for its path. Call at the top level of a test file.
 */
export function useTmpDir(prefix: string): () => string {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}

/** A replay store that records every `(keyId, nonce)` it is asked to remember. */
export class RecordingNonceStore implements NonceStore {
  readonly remembered: string[] = [];
  readonly #inner: InMemoryNonceStore;

  constructor(inner: InMemoryNonceStore) {
    this.#inner = inner;
  }

  get startedAt(): number | null {
    return this.#inner.startedAt;
  }

  now(): number {
    return this.#inner.now();
  }

  has(keyId: string, nonce: string): boolean {
    return this.#inner.has(keyId, nonce);
  }

  remember(keyId: string, nonce: string, ttlMs: number): boolean {
    this.remembered.push(`${keyId} ${nonce}`);
    return this.#inner.remember(keyId, nonce, ttlMs);
  }
}

let appSeq = 0;

export interface FreshAppOptions {
  /** Keep the replay warm-up (§4.5 "Restarts"): T₀ = boot, on the real clock. */
  readonly warmup?: boolean;
  /** Federation policy env (default: deny {@link DENIED}). */
  readonly policy?: Record<string, string>;
}

/** Boots a provider recording its outbound fetches (`calls`) and nonces (`nonces`). */
export function freshApp(tmp: string, opts: FreshAppOptions = {}) {
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
  const nonces = new RecordingNonceStore(
    new InMemoryNonceStore(opts.warmup === true ? {} : { startedAt: 0 }),
  );
  const app = createApp(config, { db, federationFetch, nonceStore: nonces });
  return { app, db, calls, nonces };
}
export type App = ReturnType<typeof freshApp>["app"];

export interface Signer {
  actor: string;
  keyId: string;
  privateKey: string;
}

export async function registerUserWithKey(app: App, handle: string): Promise<Signer> {
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

/** A route to probe: method + path; a POST/PATCH carries `{}` as its body. */
export interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
}

function routeBody(route: Route): string | undefined {
  return route.method === "POST" || route.method === "PATCH" ? "{}" : undefined;
}

/** Sends `route` with `headers` (and `{}` as the body of a POST/PATCH). */
export async function send(
  app: App,
  route: Route,
  headers: Record<string, string>,
): Promise<Response> {
  const body = routeBody(route);
  return await app.request(route.path, {
    method: route.method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/** Timestamp / nonce overrides for a signature. */
export interface SignExtra {
  timestamp?: string;
  nonce?: string;
}

/** Headers of `route` signed by `signer` (body `{}` for a POST/PATCH). */
export function actorHeaders(
  signer: Signer,
  route: Route,
  extra: SignExtra = {},
): Record<string, string> {
  const body = routeBody(route);
  return sign({
    ...signer,
    authority: DOMAIN,
    method: route.method,
    path: route.path,
    ...(body !== undefined ? { body } : {}),
    ...extra,
  }).headers;
}

/** Headers of `route` signed by `provider` with a fresh (unpublished) key. */
export function providerHeaders(
  provider: string,
  route: Route,
  extra: SignExtra & { keyId?: string; privateKey?: string } = {},
): Record<string, string> {
  const body = routeBody(route);
  const { keyId, privateKey, ...rest } = extra;
  return signProvider({
    provider,
    keyId: keyId ?? "pk_test",
    privateKey: privateKey ?? generateKeyPair().privateKey,
    authority: DOMAIN,
    method: route.method,
    path: route.path,
    ...(body !== undefined ? { body } : {}),
    ...rest,
  }).headers;
}

/** A user of the denied provider, with a key nobody can resolve. */
export function deniedActor(): Signer {
  return {
    actor: `mallory@${DENIED}`,
    keyId: "dk_mallory",
    privateKey: generateKeyPair().privateKey,
  };
}

export function deniedProviderHeaders(route: Route): Record<string, string> {
  return providerHeaders(DENIED, route, { keyId: "pk_evil" });
}

/** `headers` with the digest replaced by a wrong one (§4.5 step 5). */
export function withBadDigest(headers: Record<string, string>): Record<string, string> {
  return { ...headers, [HEADER.CONTENT_DIGEST]: "AAAA" };
}

export async function expectProblem(
  res: Response,
  status: number,
  errorCode: string,
): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect(((await res.json()) as { errorCode: string }).errorCode).toBe(errorCode);
}

/** Public routes that serve an unsigned request with `200`. */
export const PUBLIC_200: Route[] = [
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
export const PUBLIC_OTHER: Route[] = [
  { method: "GET", path: "/api/providers" },
  { method: "GET", path: "/api/discover" },
  { method: "GET", path: "/api/media/med_unknown" },
  { method: "GET", path: "/api/push/_egress-check" },
  { method: "POST", path: "/api/auth/register" },
  { method: "POST", path: "/api/auth/login" },
  { method: "POST", path: "/api/auth/device-keys" },
  { method: "POST", path: "/api/invites/inv_unknown/guest" },
];

/** Routes that take user signatures only and refuse unsigned callers (`401`). */
export function userOnlyRoutes(groupId: string): Route[] {
  return [
    { method: "GET", path: "/api/auth/device-keys" },
    { method: "GET", path: "/api/me" },
    { method: "GET", path: "/api/me/dms" },
    { method: "POST", path: "/api/groups" },
    { method: "GET", path: `/api/groups/${groupId}/members` },
    { method: "POST", path: `/api/groups/${groupId}/join` },
  ];
}

/** §4.5 anonymous-reader routes (user-signed or unsigned). */
export function anonymousReaderRoutes(
  groupId: string,
  channelId: string,
  messageId: string,
): Route[] {
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
export async function seed(app: App) {
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
