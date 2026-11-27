/**
 * A single real provider for HTTP + WebSocket tests: boot on an ephemeral port
 * (real `Bun.serve` + WS), register users with device keys, make signed REST
 * calls, and drive authenticated WS connections with await-by-predicate frames.
 * No mocks. Argon2id cost is reduced (TEST-ONLY) so registration stays fast.
 */
import { expect } from "bun:test";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type WsEnvelope,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signWsAuthenticate,
} from "@forumall/shared";

import { type AppWithWebSocket, createApp } from "../../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../../src/config.ts";
import { openDb } from "../../src/db/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { groupMembers } from "../../src/db/schema.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
export const DOMAIN = "providera.test";

const FAST_TIMINGS = {
  authTimeoutMs: 1000,
  challengeTtlMs: 10_000,
  pingIntervalMs: 5_000,
  idleTimeoutMs: 100_000,
};

export interface Booted {
  app: AppWithWebSocket;
  db: ReturnType<typeof openDb>;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
  url: string;
}

/**
 * Boot the app under `dir` (one SQLite file per `name`) with a real WS server.
 * `env` adds `loadConfig` overrides (e.g. `MAX_UPLOAD_BYTES`).
 */
export function boot(dir: string, name: string, env: Record<string, string> = {}): Booted {
  const base = loadConfig({
    DATA_DIR: dir,
    DB_PATH: join(dir, `${name}.sqlite`),
    WEB_DIR: join(dir, `${name}-web`),
    DOMAIN,
    ...env,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { testOnlySkipReplayWarmup: true, db, wsTimings: FAST_TIMINGS });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  const url = `ws://${server.hostname}:${server.port}/api/ws`;
  return { app, db, config, server, url };
}

export interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
}

function http(b: Booted, path: string, init: RequestInit): Promise<Response> {
  return fetch(`http://${b.server.hostname}:${b.server.port}${path}`, init);
}

export async function registerUserWithKey(b: Booted, handle: string): Promise<Signer> {
  const reg = await http(b, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const res = await http(b, "/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}` };
}

/**
 * A signed request. `rawBody` is sent byte-for-byte (for non-JSON-object
 * bodies); otherwise `bodyObj` is JSON-encoded.
 */
export function signedReq(
  b: Booted,
  signer: Signer,
  method: string,
  path: string,
  bodyObj?: unknown,
  rawBody?: string,
): Promise<Response> {
  const body = rawBody ?? (bodyObj === undefined ? undefined : JSON.stringify(bodyObj));
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
  return http(b, path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/** Create a group and a text channel owned by `owner`, both at `tier`. */
export async function makeGroupChannel(
  b: Booted,
  owner: Signer,
  tier: "public" | "group" = "public",
  permissions?: Record<string, string[]>,
): Promise<{ groupId: string; channelId: string }> {
  const gRes = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier });
  expect(gRes.status).toBe(201);
  const groupId = ((await gRes.json()) as { id: string }).id;
  const cRes = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
    type: "text",
    name: "general",
    tier,
    ...(permissions ? { permissions } : {}),
  });
  expect(cRes.status).toBe(201);
  const channelId = ((await cRes.json()) as { id: string }).id;
  return { groupId, channelId };
}

/** Insert a membership row directly (the membership flow is tested elsewhere). */
export function addMember(b: Booted, groupId: string, signer: Signer, role: string): void {
  b.db.drizzle
    .insert(groupMembers)
    .values({ groupId, user: signer.actor, role, joinedAt: Date.now() })
    .run();
}

/** A tiny WS client that queues frames and awaits them by predicate. */
export class WsClient {
  readonly ws: WebSocket;
  private readonly queue: WsEnvelope[] = [];
  private readonly waiters: ((f: WsEnvelope) => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as WsEnvelope;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
  }

  static async open(url: string): Promise<WsClient> {
    const c = new WsClient(url);
    await new Promise<void>((resolve, reject) => {
      c.ws.addEventListener("open", () => resolve(), { once: true });
      c.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    return c;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  next(pred: (f: WsEnvelope) => boolean = () => true, timeoutMs = 2000): Promise<WsEnvelope> {
    const queued = this.queue.findIndex(pred);
    if (queued !== -1) return Promise.resolve(this.queue.splice(queued, 1)[0] as WsEnvelope);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      const waiter = (f: WsEnvelope) => {
        if (!pred(f)) {
          this.queue.push(f);
          this.waiters.unshift(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push(waiter);
    });
  }

  ofType(type: string, timeoutMs = 2000): Promise<WsEnvelope> {
    return this.next((f) => f.type === type, timeoutMs);
  }

  /** Frames received and not yet consumed (for "nothing else arrived" checks). */
  pending(): readonly WsEnvelope[] {
    return this.queue;
  }

  close(): void {
    this.ws.close();
  }
}

export async function connectAuthenticated(b: Booted, signer: Signer): Promise<WsClient> {
  const client = await WsClient.open(b.url);
  const challenge = await client.ofType("auth.challenge");
  const nonce = (challenge.data as { nonce: string }).nonce;
  const timestamp = rfc3339Timestamp();
  const { signature } = signWsAuthenticate({
    privateKey: signer.privateKey,
    authority: DOMAIN,
    challengeNonce: nonce,
    timestamp,
  });
  client.send({
    id: "cli_auth",
    type: "authenticate",
    ts: rfc3339Timestamp(),
    data: { actor: signer.actor, keyId: signer.keyId, timestamp, signature },
  });
  await client.ofType("authenticated");
  return client;
}

/** Subscribe `client` to `channelId`, optionally resuming after `since`. */
export async function subscribe(
  client: WsClient,
  channelId: string,
  since?: string,
): Promise<void> {
  client.send({
    id: `sub_${channelId}`,
    type: "subscribe",
    ts: rfc3339Timestamp(),
    data: { channels: [channelId], ...(since ? { since: { [channelId]: since } } : {}) },
  });
  await client.ofType("subscribed");
}
