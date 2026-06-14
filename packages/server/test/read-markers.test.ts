/**
 * Read/unread tracking tests (read-markers — a provider-local extension).
 *
 * Covers:
 *  - `setReadMarkers` / `getReadMarkers` round-trip.
 *  - The monotonic guard: a backward set is ignored.
 *  - Unread counts exclude the user's OWN messages.
 *  - Unread counts for channels AND DMs, advanced by a marker.
 *  - `GET /api/me/read-markers` summary + `PATCH /api/me/read-markers` over the
 *    real signed HTTP surface.
 *  - The PATCH `read.updated` fan-out to the actor's OTHER device (multi-device
 *    sync) over a real `Bun.serve` + `new WebSocket` (no mocks).
 *
 * Channel/DM data is seeded via the provider helpers (messages are normally
 * created over WS); the read-marker logic under test is storage + aggregation.
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
import { type Db, openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { createChannel } from "../src/provider/channels.ts";
import { storeDmMessage } from "../src/provider/dms.ts";
import { addMember } from "../src/provider/membership.ts";
import { createMessage } from "../src/provider/messages.ts";
import { getReadMarkers, getUnreadSummary, setReadMarkers } from "../src/provider/read-markers.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

const FAST_TIMINGS = {
  authTimeoutMs: 300,
  challengeTtlMs: 10_000,
  pingIntervalMs: 100_000,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-readmarkers-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Booted {
  app: AppWithWebSocket;
  db: Db;
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
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db, wsTimings: FAST_TIMINGS });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  const b: Booted = {
    app,
    db,
    config,
    server,
    url: `ws://${server.hostname}:${server.port}/api/ws`,
  };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

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

/** Seed a private group owned by `owner`, return its id. */
function seedGroup(b: Booted, owner: Signer): string {
  const groupId = `grp_${owner.handle}`;
  addMember(b.db, groupId, owner.actor, "owner");
  return groupId;
}

/** Post `text` from `author` in `(groupId, channelId)`; return its seq. */
function post(b: Booted, groupId: string, channelId: string, author: string, text: string): number {
  return createMessage(b.db, b.config, {
    groupId,
    channelId,
    author,
    type: "message",
    content: { text, mime: "text/plain" },
  }).seq;
}

// ---------------------------------------------------------------------------
// Provider: setReadMarkers / getReadMarkers / getUnreadSummary
// ---------------------------------------------------------------------------

describe("read-markers provider", () => {
  test("set + get round-trip", () => {
    const b = boot("rm-roundtrip");
    setReadMarkers(b.db, "alice", [
      { scopeId: "chn_a", lastReadSeq: 5 },
      { scopeId: "chn_b", lastReadSeq: 9 },
    ]);
    const got = getReadMarkers(b.db, "alice");
    expect(got.get("chn_a")).toBe(5);
    expect(got.get("chn_b")).toBe(9);
  });

  test("monotonic: a backward set is ignored", () => {
    const b = boot("rm-monotonic");
    const a1 = setReadMarkers(b.db, "alice", [{ scopeId: "chn_a", lastReadSeq: 10 }]);
    expect(a1.has("chn_a")).toBe(true);
    // Lower value → ignored, not advanced.
    const a2 = setReadMarkers(b.db, "alice", [{ scopeId: "chn_a", lastReadSeq: 4 }]);
    expect(a2.has("chn_a")).toBe(false);
    expect(getReadMarkers(b.db, "alice").get("chn_a")).toBe(10);
    // Equal value → also a no-op.
    const a3 = setReadMarkers(b.db, "alice", [{ scopeId: "chn_a", lastReadSeq: 10 }]);
    expect(a3.has("chn_a")).toBe(false);
    // Forward → advances.
    const a4 = setReadMarkers(b.db, "alice", [{ scopeId: "chn_a", lastReadSeq: 11 }]);
    expect(a4.has("chn_a")).toBe(true);
    expect(getReadMarkers(b.db, "alice").get("chn_a")).toBe(11);
  });

  test("channel unread excludes the user's OWN messages", async () => {
    const b = boot("rm-own");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    // 2 from bob, 1 from alice. From alice's view, only bob's 2 are unread.
    post(b, groupId, ch.id, bob.actor, "hi");
    post(b, groupId, ch.id, alice.actor, "my own");
    post(b, groupId, ch.id, bob.actor, "again");

    const summary = getUnreadSummary(b.db, "alice", alice.actor);
    const entry = summary.find((s) => s.scopeId === ch.id);
    expect(entry).toBeDefined();
    expect(entry?.unreadCount).toBe(2);
    // Channel scopes carry their owning group id (for the rail rollup).
    expect(entry?.groupId).toBe(groupId);

    // Bob's view: only alice's 1 message is unread to him.
    const bobSummary = getUnreadSummary(b.db, "bob", bob.actor);
    expect(bobSummary.find((s) => s.scopeId === ch.id)?.unreadCount).toBe(1);
  });

  test("channel unread advances when a marker is set", async () => {
    const b = boot("rm-advance");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    const s1 = post(b, groupId, ch.id, bob.actor, "1");
    const s2 = post(b, groupId, ch.id, bob.actor, "2");
    post(b, groupId, ch.id, bob.actor, "3");

    // No marker → all 3 unread.
    expect(
      getUnreadSummary(b.db, "alice", alice.actor).find((s) => s.scopeId === ch.id)?.unreadCount,
    ).toBe(3);

    // Mark read through s2 → only the 3rd remains unread.
    setReadMarkers(b.db, "alice", [{ scopeId: ch.id, lastReadSeq: s2 }]);
    expect(
      getUnreadSummary(b.db, "alice", alice.actor).find((s) => s.scopeId === ch.id)?.unreadCount,
    ).toBe(1);
    expect(s2).toBeGreaterThan(s1);
  });

  test("DM unread counts inbox messages from the counterparty", async () => {
    const b = boot("rm-dm");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // Two messages land in alice's inbox from bob, one from alice herself.
    storeDmMessage(b.db, b.config, {
      dmId,
      owner: "alice",
      author: bob.actor,
      content: { text: "yo", mime: "text/plain" },
    });
    storeDmMessage(b.db, b.config, {
      dmId,
      owner: "alice",
      author: alice.actor,
      content: { text: "mine", mime: "text/plain" },
    });
    const last = storeDmMessage(b.db, b.config, {
      dmId,
      owner: "alice",
      author: bob.actor,
      content: { text: "again", mime: "text/plain" },
    });

    // alice's own message is excluded → 2 unread.
    const summary = getUnreadSummary(b.db, "alice", alice.actor);
    const entry = summary.find((s) => s.scopeId === dmId);
    expect(entry).toBeDefined();
    expect(entry?.unreadCount).toBe(2);

    // Mark read to the latest → 0 unread.
    setReadMarkers(b.db, "alice", [{ scopeId: dmId, lastReadSeq: last.seq }]);
    expect(
      getUnreadSummary(b.db, "alice", alice.actor).find((s) => s.scopeId === dmId)?.unreadCount,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP: GET / PATCH /api/me/read-markers
// ---------------------------------------------------------------------------

describe("GET/PATCH /api/me/read-markers", () => {
  test("GET summary returns visible channel + DM scopes with unread counts", async () => {
    const b = boot("rm-http-get");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });
    post(b, groupId, ch.id, bob.actor, "hey");

    const dmId = deriveDmId(alice.actor, bob.actor);
    storeDmMessage(b.db, b.config, {
      dmId,
      owner: "alice",
      author: bob.actor,
      content: { text: "dm", mime: "text/plain" },
    });

    const res = await signedReq(b, alice, "GET", "/api/me/read-markers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scopes: { scopeId: string; lastReadSeq: number; unreadCount: number; groupId?: string }[];
    };
    const chEntry = body.scopes.find((s) => s.scopeId === ch.id);
    const dmEntry = body.scopes.find((s) => s.scopeId === dmId);
    expect(chEntry?.unreadCount).toBe(1);
    expect(dmEntry?.unreadCount).toBe(1);
    // Channel scope carries its owning group id; DM scope has none.
    expect(chEntry?.groupId).toBe(groupId);
    expect(dmEntry?.groupId).toBeUndefined();
  });

  test("PATCH advances a marker; backward value is ignored", async () => {
    const b = boot("rm-http-patch");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });
    post(b, groupId, ch.id, bob.actor, "a");
    const s2 = post(b, groupId, ch.id, bob.actor, "b");

    const patch = await signedReq(b, alice, "PATCH", "/api/me/read-markers", {
      markers: [{ scopeId: ch.id, lastReadSeq: s2 }],
    });
    expect(patch.status).toBe(200);
    const pbody = (await patch.json()) as { scopes: { scopeId: string; unreadCount: number }[] };
    expect(pbody.scopes.find((s) => s.scopeId === ch.id)?.unreadCount).toBe(0);

    // A backward PATCH is a no-op → reported scopes empty.
    const back = await signedReq(b, alice, "PATCH", "/api/me/read-markers", {
      markers: [{ scopeId: ch.id, lastReadSeq: 1 }],
    });
    expect(back.status).toBe(200);
    expect(((await back.json()) as { scopes: unknown[] }).scopes.length).toBe(0);

    // The stored marker stayed at s2: GET shows 0 unread.
    const get = await signedReq(b, alice, "GET", "/api/me/read-markers");
    const gbody = (await get.json()) as { scopes: { scopeId: string; unreadCount: number }[] };
    expect(gbody.scopes.find((s) => s.scopeId === ch.id)?.unreadCount).toBe(0);
  });

  test("PATCH with an invalid body → 400", async () => {
    const b = boot("rm-http-bad");
    const alice = await registerUserWithKey(b, "alice");
    const res = await signedReq(b, alice, "PATCH", "/api/me/read-markers", { markers: [] });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Multi-device sync: read.updated fan-out
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

describe("read.updated multi-device fan-out", () => {
  test("PATCH on one device pushes read.updated to the actor's other device", async () => {
    const b = boot("rm-fanout");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });
    post(b, groupId, ch.id, bob.actor, "x");
    const s2 = post(b, groupId, ch.id, bob.actor, "y");

    // alice's second device holds a live WS connection.
    const device2 = await connectAuthenticated(b, alice);

    // The first device PATCHes its read marker over REST.
    const patch = await signedReq(b, alice, "PATCH", "/api/me/read-markers", {
      markers: [{ scopeId: ch.id, lastReadSeq: s2 }],
    });
    expect(patch.status).toBe(200);

    // device2 receives read.updated with the advanced marker + 0 unread.
    const evt = await device2.ofType("read.updated");
    const data = evt.data as {
      markers: { scopeId: string; lastReadSeq: number; unreadCount: number; groupId?: string }[];
    };
    const m = data.markers.find((x) => x.scopeId === ch.id);
    expect(m).toBeDefined();
    expect(m?.lastReadSeq).toBe(s2);
    expect(m?.unreadCount).toBe(0);
    // The recomputed channel marker carries its owning group id for the rollup.
    expect(m?.groupId).toBe(groupId);

    device2.close();
  });
});
