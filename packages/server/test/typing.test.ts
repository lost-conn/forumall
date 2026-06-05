/**
 * Typing-indicator tests (spec §7.1 "Typing indicators").
 *
 * Typing is ephemeral WS soft state: a `typing.start` fans out a
 * `channel.typing { state: "start" }` to channel subscribers, a `typing.stop`
 * (or auto-expiry, or disconnect) fans out `state: "stop"`. Nothing is
 * persisted and nothing is replayed on resume.
 *
 * All over a real `Bun.serve` + `new WebSocket`, mirroring `reactions.test.ts`.
 * A short `typingTimeoutMs` keeps the auto-expiry case fast; sockets are closed
 * and the server stopped on teardown so no timer keeps the loop alive.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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

import { type AppWithWebSocket, createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import type { Hub } from "../src/provider/ws-hub.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

/** A tiny typing timeout so the auto-expiry case resolves quickly. */
const TYPING_TIMEOUT_MS = 200;

const FAST_TIMINGS = {
  authTimeoutMs: 300,
  challengeTtlMs: 10_000,
  // Keep the heartbeat ping out of the way of typing assertions.
  pingIntervalMs: 100_000,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-typing-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Booted {
  app: AppWithWebSocket;
  hub: Hub;
  db: ReturnType<typeof openDb>;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
  url: string;
}

const booted: Booted[] = [];

function boot(name: string): Booted {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({
    ...base,
    argon2: FAST_ARGON2,
    typingTimeoutMs: TYPING_TIMEOUT_MS,
  });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db, wsTimings: FAST_TIMINGS });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  const url = `ws://${server.hostname}:${server.port}/api/ws`;
  const b: Booted = { app, hub: app.__hub, db, config, server, url };
  booted.push(b);
  return b;
}

afterEach(() => {
  // Stopping the server closes sockets, which runs onClose → clears typing
  // timers, so no leaked timer keeps the test loop alive.
  for (const b of booted.splice(0)) b.server.stop(true);
});

// ---------------------------------------------------------------------------
// HTTP + signing helpers (subset of reactions.test.ts).
// ---------------------------------------------------------------------------

interface Signer {
  keyId: string;
  privateKey: string;
  publicKey: string;
  actor: string;
  handle: string;
}

function http(b: Booted, path: string, init: RequestInit): Promise<Response> {
  return fetch(`http://${b.server.hostname}:${b.server.port}${path}`, init);
}

async function registerUserWithKey(b: Booted, handle: string): Promise<Signer> {
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

function signedReq(
  b: Booted,
  signer: Signer,
  method: string,
  path: string,
  bodyObj?: unknown,
): Promise<Response> {
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
  return http(b, path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/** Create a group owned by `owner` + a text channel of `tier`. */
async function makeGroupChannel(
  b: Booted,
  owner: Signer,
  tier: string,
): Promise<{ groupId: string; channelId: string }> {
  const gRes = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: "private" });
  expect(gRes.status).toBe(201);
  const groupId = ((await gRes.json()) as { id: string }).id;
  const cRes = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
    type: "text",
    name: "general",
    tier,
  });
  expect(cRes.status).toBe(201);
  const channelId = ((await cRes.json()) as { id: string }).id;
  return { groupId, channelId };
}

// ---------------------------------------------------------------------------
// Tiny WS client (subset of ws.test.ts / reactions.test.ts).
// ---------------------------------------------------------------------------

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: WsEnvelope[] = [];
  private readonly waiters: ((f: WsEnvelope) => void)[] = [];
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as WsEnvelope;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
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
      const waiter = (f: WsEnvelope) => {
        if (!pred(f)) {
          this.queue.push(f);
          this.waiters.unshift(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(f);
      };
      const timer = setTimeout(() => {
        // Deregister this waiter so a leftover from a timed-out wait never
        // swallows a later frame (matters for the `none()` negative assertion).
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error("timeout waiting for frame"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  ofType(type: string, timeoutMs = 2000): Promise<WsEnvelope> {
    return this.next((f) => f.type === type, timeoutMs);
  }

  /** Resolve true if NO frame matching `pred` arrives within `ms` (else false). */
  async none(pred: (f: WsEnvelope) => boolean, ms: number): Promise<boolean> {
    try {
      await this.next(pred, ms);
      return false;
    } catch {
      return true;
    }
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

async function connectAuthenticated(b: Booted, signer: Signer): Promise<WsClient> {
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

async function subscribe(client: WsClient, channelId: string, id = "sub"): Promise<void> {
  client.send({ id, type: "subscribe", ts: rfc3339Timestamp(), data: { channels: [channelId] } });
  await client.ofType("subscribed");
}

interface TypingData {
  channelId: string;
  user: string;
  state: "start" | "stop";
}

// ---------------------------------------------------------------------------
// Tests (§7.1 "Typing indicators")
// ---------------------------------------------------------------------------

describe("WS typing indicators (§7.1)", () => {
  test("typing.start / typing.stop fan out channel.typing to other subscribers", async () => {
    const b = boot("ty-start-stop");
    const alice = await registerUserWithKey(b, "alice");
    const { channelId } = await makeGroupChannel(b, alice, "public");
    const bob = await registerUserWithKey(b, "bob");

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId);
    await subscribe(bConn, channelId);

    a.send({ id: "ty_start", type: "typing.start", ts: rfc3339Timestamp(), data: { channelId } });
    const start = await bConn.ofType("channel.typing");
    const startData = start.data as TypingData;
    expect(startData.channelId).toBe(channelId);
    expect(startData.user).toBe(alice.actor);
    expect(startData.state).toBe("start");

    a.send({ id: "ty_stop", type: "typing.stop", ts: rfc3339Timestamp(), data: { channelId } });
    const stop = await bConn.next(
      (f) => f.type === "channel.typing" && (f.data as TypingData).state === "stop",
    );
    const stopData = stop.data as TypingData;
    expect(stopData.user).toBe(alice.actor);
    expect(stopData.state).toBe("stop");

    a.close();
    bConn.close();
  });

  test("auto-expire: a silent start emits an automatic stop after the timeout", async () => {
    const b = boot("ty-expire");
    const alice = await registerUserWithKey(b, "alice");
    const { channelId } = await makeGroupChannel(b, alice, "public");
    const bob = await registerUserWithKey(b, "bob");

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId);
    await subscribe(bConn, channelId);

    a.send({ id: "ty_start", type: "typing.start", ts: rfc3339Timestamp(), data: { channelId } });
    const start = await bConn.ofType("channel.typing");
    expect((start.data as TypingData).state).toBe("start");

    // No explicit stop from A — the server's auto-expiry must emit one.
    const stop = await bConn.next(
      (f) => f.type === "channel.typing" && (f.data as TypingData).state === "stop",
      TYPING_TIMEOUT_MS * 6,
    );
    expect((stop.data as TypingData).user).toBe(alice.actor);
    expect((stop.data as TypingData).state).toBe("stop");

    a.close();
    bConn.close();
  });

  test("a refreshing typing.start resets the auto-expiry timer (no premature stop)", async () => {
    const b = boot("ty-refresh");
    const alice = await registerUserWithKey(b, "alice");
    const { channelId } = await makeGroupChannel(b, alice, "public");
    const bob = await registerUserWithKey(b, "bob");

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId);
    await subscribe(bConn, channelId);

    a.send({ id: "ty_1", type: "typing.start", ts: rfc3339Timestamp(), data: { channelId } });
    const first = await bConn.ofType("channel.typing");
    expect((first.data as TypingData).state).toBe("start");

    // Refresh well before the timeout (at ~60% of it). The reset must prevent a
    // stop from firing for at least another full window after the refresh.
    await Bun.sleep(Math.floor(TYPING_TIMEOUT_MS * 0.6));
    a.send({ id: "ty_2", type: "typing.start", ts: rfc3339Timestamp(), data: { channelId } });
    await bConn.next(
      (f) => f.type === "channel.typing" && (f.data as TypingData).state === "start",
    );

    // Between the refresh and ~one original window later, there must be NO stop
    // (the original timer was reset, so it would have fired ~now without reset).
    const noPrematureStop = await bConn.none(
      (f) => f.type === "channel.typing" && (f.data as TypingData).state === "stop",
      Math.floor(TYPING_TIMEOUT_MS * 0.7),
    );
    expect(noPrematureStop).toBe(true);

    // Eventually it still expires after the refreshed window.
    const stop = await bConn.next(
      (f) => f.type === "channel.typing" && (f.data as TypingData).state === "stop",
      TYPING_TIMEOUT_MS * 6,
    );
    expect((stop.data as TypingData).state).toBe("stop");

    a.close();
    bConn.close();
  });

  test("disconnect while typing emits a stop for the dropped user", async () => {
    const b = boot("ty-disconnect");
    const alice = await registerUserWithKey(b, "alice");
    const { channelId } = await makeGroupChannel(b, alice, "public");
    const bob = await registerUserWithKey(b, "bob");

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId);
    await subscribe(bConn, channelId);

    a.send({ id: "ty_start", type: "typing.start", ts: rfc3339Timestamp(), data: { channelId } });
    const start = await bConn.ofType("channel.typing");
    expect((start.data as TypingData).state).toBe("start");

    // A drops its socket — the server must emit a stop for A so the indicator
    // never stays stuck for B.
    a.close();
    const stop = await bConn.next(
      (f) => f.type === "channel.typing" && (f.data as TypingData).state === "stop",
    );
    expect((stop.data as TypingData).user).toBe(alice.actor);
    expect((stop.data as TypingData).state).toBe("stop");

    bConn.close();
  });

  test("typing.start to a channel the actor can't see → forbidden, no fan-out", async () => {
    const b = boot("ty-forbidden");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob"); // not a member
    const { channelId } = await makeGroupChannel(b, owner, "private");

    // Owner subscribes so we can assert NOTHING is fanned out to the channel.
    const ownerConn = await connectAuthenticated(b, owner);
    await subscribe(ownerConn, channelId);

    const bobConn = await connectAuthenticated(b, bob);
    bobConn.send({
      id: "ty_forbidden",
      type: "typing.start",
      ts: rfc3339Timestamp(),
      data: { channelId },
    });
    const err = await bobConn.ofType("error");
    expect((err.data as { code: string }).code).toBe("forbidden");
    expect((err.data as { status: number }).status).toBe(403);
    expect(err.correlationId).toBe("ty_forbidden");

    // No channel.typing reached the channel's legitimate subscriber.
    const noFanout = await ownerConn.none(
      (f) => f.type === "channel.typing",
      TYPING_TIMEOUT_MS * 2,
    );
    expect(noFanout).toBe(true);

    ownerConn.close();
    bobConn.close();
  });
});
