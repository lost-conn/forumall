/**
 * Harness for the WebSocket transport suites (spec §7.1, `ws-*.test.ts`).
 *
 * Unlike the in-process `app.request(...)` suites, the WS path needs a REAL
 * socket, so each `boot()` starts the app on an ephemeral port via `Bun.serve`
 * (passing the app's `__websocket` handler) and connects with `new WebSocket`.
 * Device keys are registered over HTTP and the `authenticate` frame is signed
 * with the shared `signWsAuthenticate` helper.
 *
 * Heartbeat/handshake timings are configured SHORT so timeout/close paths run
 * fast. {@link useWsBoot} registers the suite's temp dir and stops every booted
 * server after each test, so the suite exits cleanly.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import type { WsTimings } from "../../src/http/ws.ts";
import type { Hub } from "../../src/provider/ws-hub.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
export const DOMAIN = "providera.test";

// Short timings so timeout/heartbeat paths fire quickly. ping interval doubles
// as the idle sweep, so it must be < idleTimeoutMs for the sweep to ever run.
export const FAST_TIMINGS: Partial<WsTimings> = {
  authTimeoutMs: 300,
  challengeTtlMs: 10_000,
  pingIntervalMs: 80,
  idleTimeoutMs: 100_000,
};

export interface Booted {
  app: AppWithWebSocket;
  hub: Hub;
  db: ReturnType<typeof openDb>;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
  url: string;
}

/** Boot the app on an ephemeral port with a real WS server. */
export type BootFn = (
  name: string,
  timings?: Partial<WsTimings>,
  env?: Record<string, string>,
  mintChallengeNonce?: () => string,
) => Booted;

/**
 * Register this suite's lifecycle hooks (a temp dir for its SQLite files, and
 * stopping every server booted by a test once it ends) and return its `boot`.
 * Call once, at the top level of a test file.
 */
export function useWsBoot(prefix: string): BootFn {
  let tmp = "";
  const booted: Booted[] = [];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), prefix));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const b of booted.splice(0)) b.server.stop(true);
  });

  return (name, timings, env, mintChallengeNonce) => {
    const base = loadConfig({
      DATA_DIR: tmp,
      DB_PATH: join(tmp, `${name}.sqlite`),
      WEB_DIR: join(tmp, `${name}-web`),
      DOMAIN,
      ...(env ?? {}),
    });
    const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
    const db = openDb(config.dbPath);
    migrate(db);
    const app = createApp(config, {
      testOnlySkipReplayWarmup: true,
      db,
      wsTimings: timings ?? FAST_TIMINGS,
      ...(mintChallengeNonce !== undefined ? { mintChallengeNonce } : {}),
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
    const url = `ws://${server.hostname}:${server.port}/api/ws`;
    const b: Booted = { app, hub: app.__hub, db, config, server, url };
    booted.push(b);
    return b;
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers (over the real server) to register a signing identity and set
// up groups/channels.
// ---------------------------------------------------------------------------

export interface Signer {
  keyId: string;
  privateKey: string;
  publicKey: string;
  actor: string;
  handle: string;
}

export function http(b: Booted, path: string, init: RequestInit): Promise<Response> {
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
  return { keyId, privateKey, publicKey, actor: `${handle}@${DOMAIN}`, handle };
}

/** A signed-HTTP request as `signer` (group/channel setup, REST mutations, reads). */
export function signedReq(
  b: Booted,
  signer: Signer,
  method: string,
  path: string,
  bodyObj?: unknown,
): Promise<Response> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  // The query string is a distinct signed line (§4.4.2); split it off the path.
  const qIdx = path.indexOf("?");
  const query = qIdx === -1 ? undefined : path.slice(qIdx + 1);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    path,
    ...(query !== undefined ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  return http(b, path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/**
 * Create a group owned by `owner` and a text channel in it. Both default to
 * `public`, so non-member subscribers can reach the channel; a channel tier can
 * only narrow access within its group, never widen it (§11).
 */
export async function makeGroupChannel(
  b: Booted,
  owner: Signer,
  tiers: { group?: string; channel?: string } = {},
): Promise<{ groupId: string; channelId: string }> {
  const gRes = await signedReq(b, owner, "POST", "/api/groups", {
    name: "g",
    tier: tiers.group ?? "public",
  });
  expect(gRes.status).toBe(201);
  const groupId = ((await gRes.json()) as { id: string }).id;
  const cRes = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
    type: "text",
    name: "general",
    tier: tiers.channel ?? "public",
  });
  expect(cRes.status).toBe(201);
  const channelId = ((await cRes.json()) as { id: string }).id;
  return { groupId, channelId };
}

// ---------------------------------------------------------------------------
// Tiny WS client helpers.
// ---------------------------------------------------------------------------

/** A connected WS that queues inbound frames for await-by-predicate reads. */
export class WsClient {
  readonly ws: WebSocket;
  private readonly queue: WsEnvelope[] = [];
  private readonly waiters: ((f: WsEnvelope) => void)[] = [];
  closeCode: number | undefined;
  closed = false;
  private readonly closeWaiters: (() => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as WsEnvelope;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = true;
      this.closeCode = e.code;
      for (const w of this.closeWaiters.splice(0)) w();
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

  /** Send a raw text payload, byte for byte (non-JSON, oversized, …). */
  sendText(text: string): void {
    this.ws.send(text);
  }

  /** Next frame matching `pred` (or the next frame if omitted). */
  next(pred: (f: WsEnvelope) => boolean = () => true, timeoutMs = 2000): Promise<WsEnvelope> {
    const queued = this.queue.findIndex(pred);
    if (queued !== -1) return Promise.resolve(this.queue.splice(queued, 1)[0] as WsEnvelope);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      const waiter = (f: WsEnvelope) => {
        if (!pred(f)) {
          this.queue.push(f); // not ours; requeue and keep waiting
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

  /** True iff no frame matching `pred` arrives within `ms`. */
  async none(pred: (f: WsEnvelope) => boolean, ms = 200): Promise<boolean> {
    try {
      await this.next(pred, ms);
      return false;
    } catch {
      return true;
    }
  }

  waitClosed(timeoutMs = 2000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

/** Connect, read the `auth.challenge`, and return both. */
export async function connectAndChallenge(b: Booted): Promise<{ client: WsClient; nonce: string }> {
  const client = await WsClient.open(b.url);
  const challenge = await client.ofType("auth.challenge");
  const data = challenge.data as { nonce: string };
  return { client, nonce: data.nonce };
}

/** Sign + send an `authenticate` over a given challenge nonce. */
export function sendAuthenticate(
  client: WsClient,
  signer: Signer,
  nonce: string,
  over: { signWith?: string; id?: string } = {},
): void {
  const timestamp = rfc3339Timestamp();
  const { signature } = signWsAuthenticate({
    privateKey: over.signWith ?? signer.privateKey,
    authority: DOMAIN,
    challengeNonce: nonce,
    timestamp,
  });
  client.send({
    id: over.id ?? "cli_auth_1",
    type: "authenticate",
    data: { actor: signer.actor, keyId: signer.keyId, timestamp, signature },
  });
}

/** Full happy-path connect → authenticate, resolving once `authenticated`. */
export async function connectAuthenticated(b: Booted, signer: Signer): Promise<WsClient> {
  const { client, nonce } = await connectAndChallenge(b);
  sendAuthenticate(client, signer, nonce);
  await client.ofType("authenticated");
  return client;
}

/** Subscribe `client` to `channelId` and await the `subscribed` ack. */
export async function subscribe(client: WsClient, channelId: string, id = "sub"): Promise<void> {
  client.send({ id, type: "subscribe", data: { channels: [channelId] } });
  await client.ofType("subscribed");
}
