/**
 * WebSocket transport tests (spec §7.1) — the signed-challenge handshake,
 * subscribe/unsubscribe authorization, heartbeat, hub fan-out, and the
 * connect/auth timeouts.
 *
 * Unlike the in-process `app.request(...)` suites, the WS path needs a REAL
 * socket, so each `boot()` starts the app on an ephemeral port via `Bun.serve`
 * (passing the app's `__websocket` handler) and connects with `new WebSocket`.
 * Device keys are registered over HTTP and the `authenticate` frame is signed
 * with the shared `signWsAuthenticate` helper.
 *
 * Heartbeat/handshake timings are configured SHORT so timeout/close paths run
 * fast. Sockets + servers are closed in teardown so the suite exits cleanly.
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
  signWsAuthenticate,
} from "@forumall/shared";

import { type AppWithWebSocket, createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import type { Hub } from "../src/provider/ws-hub.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

// Short timings so timeout/heartbeat paths fire quickly. ping interval doubles
// as the idle sweep, so it must be < idleTimeoutMs for the sweep to ever run.
const FAST_TIMINGS = {
  authTimeoutMs: 300,
  challengeTtlMs: 10_000,
  pingIntervalMs: 80,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-ws-"));
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

/** Boot the app on an ephemeral port with a real WS server. */
function boot(name: string, timings = FAST_TIMINGS): Booted {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db, wsTimings: timings });
  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
    websocket: app.__websocket,
  });
  const url = `ws://${server.hostname}:${server.port}/api/ws`;
  const b: Booted = { app, hub: app.__hub, db, config, server, url };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

// ---------------------------------------------------------------------------
// HTTP helpers (over the real server) to register a signing identity.
// ---------------------------------------------------------------------------

interface Signer {
  keyId: string;
  privateKey: string;
  publicKey: string;
  actor: string;
  handle: string;
}

async function http(b: Booted, path: string, init: RequestInit): Promise<Response> {
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

// ---------------------------------------------------------------------------
// Tiny WS client helpers.
// ---------------------------------------------------------------------------

/** A connected WS that queues inbound frames for await-by-predicate reads. */
class WsClient {
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
async function connectAndChallenge(b: Booted): Promise<{ client: WsClient; nonce: string }> {
  const client = await WsClient.open(b.url);
  const challenge = await client.ofType("auth.challenge");
  const data = challenge.data as { nonce: string };
  return { client, nonce: data.nonce };
}

/** Sign + send an `authenticate` over a given challenge nonce. */
function sendAuthenticate(
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
    ts: rfc3339Timestamp(),
    data: { actor: signer.actor, keyId: signer.keyId, timestamp, signature },
  });
}

/** Full happy-path connect → authenticate, resolving once `authenticated`. */
async function connectAuthenticated(b: Booted, signer: Signer): Promise<WsClient> {
  const { client, nonce } = await connectAndChallenge(b);
  sendAuthenticate(client, signer, nonce);
  await client.ofType("authenticated");
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WS handshake (§7.1 Authentication)", () => {
  test("first server frame is auth.challenge with a nonce", async () => {
    const b = boot("challenge-first");
    const client = await WsClient.open(b.url);
    const first = await client.next();
    expect(first.type).toBe("auth.challenge");
    const data = first.data as { nonce: string; expiresAt: string };
    expect(typeof data.nonce).toBe("string");
    expect(data.nonce.length).toBeGreaterThan(0);
    expect(typeof data.expiresAt).toBe("string");
    client.close();
  });

  test("a command other than authenticate first → connection closed", async () => {
    const b = boot("wrong-first");
    const { client } = await connectAndChallenge(b);
    client.send({
      id: "cli_1",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: ["chn_x"] },
    });
    await client.waitClosed();
    expect(client.closed).toBe(true);
  });

  test("valid authenticate → authenticated { actor }", async () => {
    const b = boot("auth-ok");
    const signer = await registerUserWithKey(b, "alice");
    const { client, nonce } = await connectAndChallenge(b);
    sendAuthenticate(client, signer, nonce, { id: "cli_auth_X" });
    const ack = await client.ofType("authenticated");
    expect((ack.data as { actor: string }).actor).toBe(signer.actor);
    expect(ack.correlationId).toBe("cli_auth_X");
    client.close();
  });

  test("bad signature → error then close 4001", async () => {
    const b = boot("auth-badsig");
    const signer = await registerUserWithKey(b, "alice");
    const { client, nonce } = await connectAndChallenge(b);
    // Sign with a different private key but claim the registered key id.
    const wrong = generateKeyPair();
    sendAuthenticate(client, signer, nonce, { signWith: wrong.privateKey });
    const err = await client.ofType("error");
    expect((err.data as { code: string }).status).toBe(401);
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
  });

  test("authenticate with a different/old nonce (not the one issued) → rejected", async () => {
    const b = boot("auth-wrongnonce");
    const signer = await registerUserWithKey(b, "alice");
    const { client } = await connectAndChallenge(b);
    // Sign over a nonce the server never issued for this connection.
    sendAuthenticate(client, signer, "some-other-nonce-AAAAAAAAAAAAAAAA");
    const err = await client.ofType("error");
    expect((err.data as { status: number }).status).toBe(401);
    await client.waitClosed();
    expect(client.closeCode).toBe(4001);
  });

  test("no authenticate within the timeout → closed", async () => {
    const b = boot("auth-timeout", { ...FAST_TIMINGS, authTimeoutMs: 120 });
    const { client } = await connectAndChallenge(b);
    // Send nothing; the auth-timeout must close us.
    await client.waitClosed();
    expect(client.closed).toBe(true);
  });
});

describe("WS subscriptions (§7.1)", () => {
  /** Create a group + a channel of `tier`, returning the channel id. */
  async function makeChannel(
    b: Booted,
    owner: Signer,
    tier: string,
  ): Promise<{ groupId: string; channelId: string }> {
    // Create the group via the signed HTTP API (owner becomes a member/owner).
    const { sign } = await import("@forumall/shared");
    const signedReq = (method: string, path: string, bodyObj?: unknown) => {
      const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
      const { headers } = sign({
        actor: owner.actor,
        keyId: owner.keyId,
        privateKey: owner.privateKey,
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
    };
    const gRes = await signedReq("POST", "/api/groups", { name: "g", tier: "private" });
    expect(gRes.status).toBe(201);
    const groupId = ((await gRes.json()) as { id: string }).id;
    const cRes = await signedReq("POST", `/api/groups/${groupId}/channels`, {
      type: "text",
      name: "general",
      tier,
    });
    expect(cRes.status).toBe(201);
    const channelId = ((await cRes.json()) as { id: string }).id;
    return { groupId, channelId };
  }

  test("subscribe to an authorized (public) channel → subscribed; unsubscribe → unsubscribed", async () => {
    const b = boot("sub-ok");
    const alice = await registerUserWithKey(b, "alice");
    const { channelId } = await makeChannel(b, alice, "public");
    const client = await connectAuthenticated(b, alice);

    client.send({
      id: "cli_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    const ack = await client.ofType("subscribed");
    expect((ack.data as { channels: string[] }).channels).toEqual([channelId]);
    expect(ack.correlationId).toBe("cli_sub");

    client.send({
      id: "cli_unsub",
      type: "unsubscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    const un = await client.ofType("unsubscribed");
    expect((un.data as { channels: string[] }).channels).toEqual([channelId]);
    expect(un.correlationId).toBe("cli_unsub");
    client.close();
  });

  test("subscribe to an unauthorized (private, non-member) channel → error forbidden", async () => {
    const b = boot("sub-forbidden");
    const owner = await registerUserWithKey(b, "owner");
    const { channelId } = await makeChannel(b, owner, "private");
    // bob is NOT a member of the group → cannot see a private channel.
    const bob = await registerUserWithKey(b, "bob");
    const client = await connectAuthenticated(b, bob);

    client.send({
      id: "cli_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    const err = await client.ofType("error");
    expect((err.data as { code: string }).code).toBe("forbidden");
    expect((err.data as { status: number }).status).toBe(403);
    expect(err.correlationId).toBe("cli_sub");
    client.close();
  });
});

describe("WS heartbeat (§7.1)", () => {
  test("ping → pong with correlationId echoing the ping id", async () => {
    const b = boot("ping");
    const alice = await registerUserWithKey(b, "alice");
    const client = await connectAuthenticated(b, alice);
    client.send({ id: "cli_ping_42", type: "ping", ts: rfc3339Timestamp(), data: {} });
    const pong = await client.next((f) => f.type === "pong" && f.correlationId === "cli_ping_42");
    expect(pong.correlationId).toBe("cli_ping_42");
    client.close();
  });
});

describe("Hub fan-out (§7.1)", () => {
  test("publishToChannel delivers to all connections subscribed to the channel", async () => {
    const b = boot("hub-fanout");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    // A public channel so both can subscribe without membership.
    const { sign } = await import("@forumall/shared");
    const headers = sign({
      actor: alice.actor,
      keyId: alice.keyId,
      privateKey: alice.privateKey,
      authority: DOMAIN,
      method: "POST",
      path: "/api/groups",
      body: JSON.stringify({ name: "g", tier: "public" }),
    }).headers;
    const gRes = await http(b, "/api/groups", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "g", tier: "public" }),
    });
    const groupId = ((await gRes.json()) as { id: string }).id;
    const chPath = `/api/groups/${groupId}/channels`;
    const chHeaders = sign({
      actor: alice.actor,
      keyId: alice.keyId,
      privateKey: alice.privateKey,
      authority: DOMAIN,
      method: "POST",
      path: chPath,
      body: JSON.stringify({ type: "text", tier: "public" }),
    }).headers;
    const cRes = await http(b, chPath, {
      method: "POST",
      headers: { ...chHeaders, "content-type": "application/json" },
      body: JSON.stringify({ type: "text", tier: "public" }),
    });
    const channelId = ((await cRes.json()) as { id: string }).id;

    const c1 = await connectAuthenticated(b, alice);
    const c2 = await connectAuthenticated(b, bob);
    for (const [c, id] of [
      [c1, "s1"],
      [c2, "s2"],
    ] as const) {
      c.send({ id, type: "subscribe", ts: rfc3339Timestamp(), data: { channels: [channelId] } });
      await c.ofType("subscribed");
    }
    expect(b.hub.subscriberCount(channelId)).toBe(2);

    // Publish directly via the hub (the message-create card will do this).
    b.hub.publishToChannel(channelId, {
      type: "message.created",
      data: { channelId, marker: "hello" },
    });
    const f1 = await c1.ofType("message.created");
    const f2 = await c2.ofType("message.created");
    expect((f1.data as { marker: string }).marker).toBe("hello");
    expect((f2.data as { marker: string }).marker).toBe("hello");
    c1.close();
    c2.close();
  });

  test("publishToActor delivers to that actor's connection", async () => {
    const b = boot("hub-actor");
    const alice = await registerUserWithKey(b, "alice");
    const client = await connectAuthenticated(b, alice);
    b.hub.publishToActor(alice.actor, { type: "dm.message", data: { marker: "dm" } });
    const f = await client.ofType("dm.message");
    expect((f.data as { marker: string }).marker).toBe("dm");
    client.close();
  });

  test("a closed connection is removed from the hub", async () => {
    const b = boot("hub-cleanup");
    const alice = await registerUserWithKey(b, "alice");
    const client = await connectAuthenticated(b, alice);
    expect(b.hub.size).toBe(1);
    client.close();
    // Give the server a tick to process the close.
    await Bun.sleep(50);
    expect(b.hub.size).toBe(0);
  });
});

describe("WS message.create + fan-out + idempotency (§7.1 Sending messages)", () => {
  /** A signed-HTTP request helper bound to a signer (group/channel setup). */
  async function signedReq(
    b: Booted,
    signer: Signer,
    method: string,
    path: string,
    bodyObj?: unknown,
  ): Promise<Response> {
    const { sign } = await import("@forumall/shared");
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

  /** Create a group owned by `owner` + a `public`-tier text channel in it. */
  async function makeGroupChannel(
    b: Booted,
    owner: Signer,
  ): Promise<{ groupId: string; channelId: string }> {
    const gRes = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: "private" });
    expect(gRes.status).toBe(201);
    const groupId = ((await gRes.json()) as { id: string }).id;
    const cRes = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
      type: "text",
      name: "general",
      tier: "public",
    });
    expect(cRes.status).toBe(201);
    const channelId = ((await cRes.json()) as { id: string }).id;
    return { groupId, channelId };
  }

  /** Subscribe `client` to `channelId` and await the `subscribed` ack. */
  async function subscribe(client: WsClient, channelId: string, id = "sub"): Promise<void> {
    client.send({ id, type: "subscribe", ts: rfc3339Timestamp(), data: { channels: [channelId] } });
    await client.ofType("subscribed");
  }

  /** Count stored messages in a channel via REST history (auth as `signer`). */
  async function historyCount(
    b: Booted,
    signer: Signer,
    groupId: string,
    channelId: string,
  ): Promise<number> {
    const res = await signedReq(
      b,
      signer,
      "GET",
      `/api/groups/${groupId}/channels/${channelId}/messages`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    return body.items.length;
  }

  test("both subscribers receive message.created; author's copy correlates + carries a cursor", async () => {
    const b = boot("msg-fanout");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId, "a_sub");
    await subscribe(bConn, channelId, "b_sub");
    expect(b.hub.subscriberCount(channelId)).toBe(2);

    a.send({
      id: "cli_post_1",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        clientMessageId: "cmsg_1",
        content: { mime: "text/plain", text: "hi" },
      },
    });

    const aEvt = await a.ofType("message.created");
    const bEvt = await bConn.ofType("message.created");

    const { MessageSchema } = await import("@forumall/shared");
    const aData = aEvt.data as { channelId: string; cursor?: string; message: unknown };
    const bData = bEvt.data as { message: { id: string } };

    // Same canonical message reaches both.
    const msg = MessageSchema.parse(aData.message);
    expect(msg.author).toBe(alice.actor);
    expect(msg.content.text).toBe("hi");
    expect(bData.message.id).toBe(msg.id);

    // Author's copy correlates to the request id; event carries a cursor.
    expect(aEvt.correlationId).toBe("cli_post_1");
    expect(typeof aData.cursor).toBe("string");
    expect((aData.cursor as string).length).toBeGreaterThan(0);

    a.close();
    bConn.close();
  });

  test("idempotency: same clientMessageId twice → one stored row, same message id", async () => {
    const b = boot("msg-idempotent");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const a = await connectAuthenticated(b, alice);
    await subscribe(a, channelId);

    const cmd = {
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        clientMessageId: "cmsg_dup",
        content: { mime: "text/plain", text: "once" },
      },
    };
    a.send({ ...cmd, id: "cli_post_a" });
    const first = await a.ofType("message.created");
    const firstId = (first.data as { message: { id: string } }).message.id;

    a.send({ ...cmd, id: "cli_post_b" });
    const second = await a.next(
      (f) => f.type === "message.created" && f.correlationId === "cli_post_b",
    );
    const secondId = (second.data as { message: { id: string } }).message.id;

    // Same canonical id returned; the duplicate's reply correlates to its id.
    expect(secondId).toBe(firstId);
    expect(second.correlationId).toBe("cli_post_b");

    // Exactly one row stored.
    expect(await historyCount(b, alice, groupId, channelId)).toBe(1);

    a.close();
  });

  test("non-member lacking post permission → error forbidden, nothing stored/fanned", async () => {
    const b = boot("msg-forbidden");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob"); // not a member
    const { groupId, channelId } = await makeGroupChannel(b, owner);

    const bobConn = await connectAuthenticated(b, bob);
    // bob can subscribe (public tier) but cannot post (not a member).
    await subscribe(bobConn, channelId);

    bobConn.send({
      id: "cli_post_x",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, content: { mime: "text/plain", text: "nope" } },
    });

    const err = await bobConn.ofType("error");
    expect((err.data as { code: string }).code).toBe("forbidden");
    expect((err.data as { status: number }).status).toBe(403);
    expect(err.correlationId).toBe("cli_post_x");

    // Nothing stored.
    expect(await historyCount(b, owner, groupId, channelId)).toBe(0);

    bobConn.close();
  });

  test("author is taken from the connection, not a spoofed payload author", async () => {
    const b = boot("msg-author");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const a = await connectAuthenticated(b, alice);
    await subscribe(a, channelId);

    a.send({
      id: "cli_post_spoof",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        author: "mallory@evil.test", // spoofed; MUST be ignored
        content: { mime: "text/plain", text: "who am i" },
      },
    });

    const evt = await a.ofType("message.created");
    const msg = (evt.data as { message: { author: string } }).message;
    expect(msg.author).toBe(alice.actor);
    expect(msg.author).not.toBe("mallory@evil.test");

    a.close();
  });
});
