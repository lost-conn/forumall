/**
 * Direct-message tests (spec §7.4, §8.3).
 *
 * Covers the single signed send path (`POST /api/federation/dms/{dmId}/messages`),
 * inbox-only storage (no sender copy), the §8.3 `{dmId}` verification (400 on
 * mismatch — inbox poisoning), idempotency, real-time `dm.message` delivery to
 * the recipient only (with a `cursor`), conversation listing, participant-only
 * reads (404/403 for a non-participant), and DM delete (tombstone).
 *
 * Like the WS suite, this needs a REAL socket for the real-time assertions, so
 * `boot()` starts the app on an ephemeral port and connects with `new WebSocket`.
 * REST calls go over the same server with the shared `sign()` helper.
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
  deriveDmId,
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

const FAST_TIMINGS = {
  authTimeoutMs: 300,
  challengeTtlMs: 10_000,
  pingIntervalMs: 80,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-dms-"));
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

function boot(name: string, env: Record<string, string> = {}): Booted {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
    ...env,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
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
  for (const b of booted.splice(0)) b.server.stop(true);
});

// ---------------------------------------------------------------------------
// HTTP helpers
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

/** A signed-HTTP request helper bound to a signer. */
async function signedReq(
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

// ---------------------------------------------------------------------------
// Tiny WS client helpers (mirrors ws.test.ts).
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

  /** Assert no frame of `type` arrives within `windowMs`. */
  async expectNoneOfType(type: string, windowMs = 300): Promise<void> {
    try {
      await this.ofType(type, windowMs);
      throw new Error(`unexpected ${type} frame arrived`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("timeout")) return;
      throw err;
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

/** Send a DM from `from` to the conversation `dmId`. */
async function sendDm(
  b: Booted,
  from: Signer,
  dmId: string,
  text: string,
  clientMessageId: string,
): Promise<Response> {
  return signedReq(b, from, "POST", `/api/federation/dms/${dmId}/messages`, {
    clientMessageId,
    content: { mime: "text/plain", text },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DM send + inbox-only storage (§7.4, §8.3)", () => {
  test("alice→bob lands in bob's inbox; alice's inbox is empty (no sender copy)", async () => {
    const b = boot("dm-basic");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const res = await sendDm(b, alice, dmId, "hey bob", "cmsg_1");
    expect(res.status).toBe(201);
    const stored = (await res.json()) as { id: string; author: string; content: { text: string } };
    expect(stored.author).toBe(alice.actor);
    expect(stored.content.text).toBe("hey bob");

    // bob reads his inbox → sees the message.
    const bobHist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    expect(bobHist.status).toBe(200);
    const bobItems = ((await bobHist.json()) as { items: { id: string; author: string }[] }).items;
    expect(bobItems.length).toBe(1);
    expect(bobItems[0]?.id).toBe(stored.id);
    expect(bobItems[0]?.author).toBe(alice.actor);

    // alice reads HER inbox for the same dmId → 404 (no sender copy stored).
    const aliceHist = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages`);
    expect(aliceHist.status).toBe(404);
  });

  test("dmId mismatch → 400, nothing stored (inbox poisoning blocked)", async () => {
    const b = boot("dm-mismatch");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");

    // dmId derived for a DIFFERENT pair (bob, carol) — author alice is not in it.
    const wrongDmId = deriveDmId(bob.actor, carol.actor);
    const res = await sendDm(b, alice, wrongDmId, "poison", "cmsg_x");
    expect(res.status).toBe(400);

    // A totally random dm_<hex> → also 400.
    const randomDmId = `dm_${"a".repeat(64)}`;
    const res2 = await sendDm(b, alice, randomDmId, "poison2", "cmsg_y");
    expect(res2.status).toBe(400);

    // Nothing landed: bob and carol have no conversation rows from alice.
    // (bob's inbox for the bob/carol dmId is unknown to bob anyway, but check
    // the (alice,bob) conversation is empty: bob has no inbox for it.)
    const ab = deriveDmId(alice.actor, bob.actor);
    const bobHist = await signedReq(b, bob, "GET", `/api/dms/${ab}/messages`);
    expect(bobHist.status).toBe(404);
  });

  test("idempotency: same clientMessageId twice → one stored row, same id", async () => {
    const b = boot("dm-idempotent");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const r1 = await sendDm(b, alice, dmId, "once", "cmsg_dup");
    expect(r1.status).toBe(201);
    const id1 = ((await r1.json()) as { id: string }).id;

    const r2 = await sendDm(b, alice, dmId, "once-again", "cmsg_dup");
    // Duplicate returns the existing stored message (200), same id.
    expect(r2.status).toBe(200);
    const id2 = ((await r2.json()) as { id: string }).id;
    expect(id2).toBe(id1);

    // Exactly one row in bob's inbox.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = ((await hist.json()) as { items: unknown[] }).items;
    expect(items.length).toBe(1);
  });
});

describe("DM real-time delivery (§7.4)", () => {
  test("bob receives dm.message with a cursor; alice (also connected) does NOT", async () => {
    const b = boot("dm-realtime");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const aConn = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);

    const res = await sendDm(b, alice, dmId, "ping", "cmsg_rt");
    expect(res.status).toBe(201);

    const evt = await bConn.ofType("dm.message");
    const data = evt.data as {
      dmId: string;
      cursor?: string;
      message: { id: string; author: string; content: { text: string }; clientMessageId?: string };
    };
    expect(data.dmId).toBe(dmId);
    expect(typeof data.cursor).toBe("string");
    expect((data.cursor as string).length).toBeGreaterThan(0);
    expect(data.message.author).toBe(alice.actor);
    expect(data.message.content.text).toBe("ping");
    expect(data.message.clientMessageId).toBe("cmsg_rt");

    // alice (the sender) must NOT receive dm.message — only the recipient's
    // inbox stored it, so only bob is notified.
    await aConn.expectNoneOfType("dm.message");

    aConn.close();
    bConn.close();
  });

  test("WS subscribe to a dm_ target: participant acks, non-participant forbidden", async () => {
    const b = boot("dm-subscribe");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // Land a message so bob has a conversation row (participant).
    await sendDm(b, alice, dmId, "hi", "cmsg_s");

    const bConn = await connectAuthenticated(b, bob);
    bConn.send({
      id: "b_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [dmId] },
    });
    const ack = await bConn.ofType("subscribed");
    expect((ack.data as { channels: string[] }).channels).toEqual([dmId]);

    // carol is not a participant of (alice,bob) → forbidden.
    const cConn = await connectAuthenticated(b, carol);
    cConn.send({
      id: "c_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [dmId] },
    });
    const err = await cConn.ofType("error");
    expect((err.data as { code: string }).code).toBe("forbidden");
    expect((err.data as { status: number }).status).toBe(403);

    bConn.close();
    cConn.close();
  });
});

describe("DM listing + participation (§7.4)", () => {
  test("GET /api/me/dms lists bob's conversation with alice (participants + lastMessage)", async () => {
    const b = boot("dm-list");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    await sendDm(b, alice, dmId, "last words", "cmsg_l");

    const res = await signedReq(b, bob, "GET", "/api/me/dms");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        id: string;
        participants: string[];
        lastMessage?: { content: { text: string } };
        updatedAt: string;
      }[];
    };
    expect(body.items.length).toBe(1);
    const conv = body.items[0];
    expect(conv?.id).toBe(dmId);
    expect(conv?.participants).toContain(bob.actor);
    expect(conv?.participants).toContain(alice.actor);
    expect(conv?.lastMessage?.content.text).toBe("last words");

    // alice keeps no sender copy → her conversation list is empty.
    const aliceList = await signedReq(b, alice, "GET", "/api/me/dms");
    const aliceItems = ((await aliceList.json()) as { items: unknown[] }).items;
    expect(aliceItems.length).toBe(0);
  });

  test("non-participant carol reading /api/dms/{dmId}/messages → 404", async () => {
    const b = boot("dm-nonparticipant");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    await sendDm(b, alice, dmId, "private", "cmsg_p");

    const res = await signedReq(b, carol, "GET", `/api/dms/${dmId}/messages`);
    expect(res.status).toBe(404);
  });
});

describe("DM delete (§7.1 tombstone on the stored copy)", () => {
  test("bob deletes a received DM → tombstone (deletedAt set, content cleared)", async () => {
    const b = boot("dm-delete");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await sendDm(b, alice, dmId, "delete me", "cmsg_d");
    const messageId = ((await sent.json()) as { id: string }).id;

    const del = await signedReq(b, bob, "DELETE", `/api/dms/${dmId}/messages/${messageId}`);
    expect(del.status).toBe(204);

    // The tombstone remains in history: same id, content cleared, deletedAt set.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = (
      (await hist.json()) as {
        items: { id: string; deletedAt?: string; content: { text: string } }[];
      }
    ).items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(messageId);
    expect(typeof items[0]?.deletedAt).toBe("string");
    expect(items[0]?.content.text).toBe("");
  });
});
