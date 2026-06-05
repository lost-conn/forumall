/**
 * Reaction tests (spec §5.3, §7.1 "Reactions").
 *
 * Two transports, one model:
 *  - **WS** (real socket via `Bun.serve`, like `ws.test.ts`): `reaction.add` /
 *    `reaction.remove` commands, idempotency, fan-out to other subscribers, two
 *    users sharing a key, and the forbidden (can't-see-channel) path.
 *  - **REST** (`app.request`, like `messages.test.ts`): `PUT`/`DELETE`
 *    `…/reactions/{key}` parity (idempotent 201→200, 204), reaching WS
 *    subscribers via the shared hub, the paginated `GET …/reactions` listing,
 *    and the private-channel 403.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Reaction,
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

const FAST_TIMINGS = {
  authTimeoutMs: 300,
  challengeTtlMs: 10_000,
  pingIntervalMs: 80,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-reactions-"));
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
// HTTP helpers (over the real server) to register + drive the signed REST API.
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
  // Split the query off `path` so the canonical string signs it (the verifier
  // reconstructs path + query separately, §4.4.2).
  const qIdx = path.indexOf("?");
  const sigPath = qIdx === -1 ? path : path.slice(0, qIdx);
  const query = qIdx === -1 ? undefined : path.slice(qIdx + 1);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    path: sigPath,
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
 * Create a group owned by `owner` + a text channel of `tier`, plus a single
 * message in it (posted by `owner` via WS). Returns the ids needed to react.
 */
async function makeGroupChannelMessage(
  b: Booted,
  owner: Signer,
  tier: string,
): Promise<{ groupId: string; channelId: string; messageId: string }> {
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

  // Post a message over WS (owner can post — they're a member with `post`).
  const conn = await connectAuthenticated(b, owner);
  await subscribe(conn, channelId);
  conn.send({
    id: "seed_msg",
    type: "message.create",
    ts: rfc3339Timestamp(),
    data: { groupId, channelId, content: { mime: "text/plain", text: "react to me" } },
  });
  const evt = await conn.next(
    (f) => f.type === "message.created" && f.correlationId === "seed_msg",
  );
  const messageId = (evt.data as { message: { id: string } }).message.id;
  conn.close();
  return { groupId, channelId, messageId };
}

// ---------------------------------------------------------------------------
// Tiny WS client (subset of ws.test.ts).
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

/** Count a message's stored reactions via the REST list endpoint (auth as signer). */
async function listReactionItems(
  b: Booted,
  signer: Signer,
  groupId: string,
  channelId: string,
  messageId: string,
): Promise<Reaction[]> {
  const res = await signedReq(
    b,
    signer,
    "GET",
    `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/reactions`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Reaction[] }).items;
}

// ---------------------------------------------------------------------------
// WS reaction.add / reaction.remove (§7.1)
// ---------------------------------------------------------------------------

describe("WS reactions (§7.1)", () => {
  test("reaction.add twice (same user/key) → one stored reaction, same id; fan-out carries full object", async () => {
    const b = boot("rx-idempotent");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId, messageId } = await makeGroupChannelMessage(b, alice, "public");

    const a = await connectAuthenticated(b, alice);
    await subscribe(a, channelId);

    const cmd = {
      type: "reaction.add",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId, key: "heart", unicode: "❤️" },
    };
    a.send({ ...cmd, id: "rx_a" });
    const first = await a.next((f) => f.type === "reaction.added" && f.correlationId === "rx_a");
    const firstData = first.data as { groupId: string; channelId: string; reaction: Reaction };
    expect(firstData.groupId).toBe(groupId);
    expect(firstData.channelId).toBe(channelId);
    expect(firstData.reaction.author).toBe(alice.actor);
    expect(firstData.reaction.key).toBe("heart");
    expect(firstData.reaction.unicode).toBe("❤️");
    expect(firstData.reaction.reference).toEqual({ type: "message", id: messageId });
    const firstId = firstData.reaction.id;

    a.send({ ...cmd, id: "rx_b" });
    const second = await a.next((f) => f.type === "reaction.added" && f.correlationId === "rx_b");
    const secondId = (second.data as { reaction: Reaction }).reaction.id;

    // Idempotent: same reaction id returned, and only ONE row exists.
    expect(secondId).toBe(firstId);
    const items = await listReactionItems(b, alice, groupId, channelId, messageId);
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(firstId);

    a.close();
  });

  test("reaction.added and reaction.removed fan out to other channel subscribers", async () => {
    const b = boot("rx-fanout");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId, messageId } = await makeGroupChannelMessage(b, alice, "public");

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId, "a_sub");
    await subscribe(bConn, channelId, "b_sub");
    expect(b.hub.subscriberCount(channelId)).toBe(2);

    a.send({
      id: "rx_add",
      type: "reaction.add",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId, key: "thumbsup", unicode: "👍" },
    });
    const added = await bConn.ofType("reaction.added");
    const r = (added.data as { reaction: Reaction }).reaction;
    expect(r.author).toBe(alice.actor);
    expect(r.key).toBe("thumbsup");

    a.send({
      id: "rx_rm",
      type: "reaction.remove",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId, key: "thumbsup" },
    });
    const removed = await bConn.ofType("reaction.removed");
    const rd = removed.data as {
      groupId: string;
      channelId: string;
      messageId: string;
      key: string;
      author: string;
    };
    expect(rd).toEqual({
      groupId,
      channelId,
      messageId,
      key: "thumbsup",
      author: alice.actor,
    });

    // Removed from storage.
    const items = await listReactionItems(b, alice, groupId, channelId, messageId);
    expect(items.length).toBe(0);

    a.close();
    bConn.close();
  });

  test("two different users adding the same key → two reactions (aggregate count=2)", async () => {
    const b = boot("rx-two-users");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId, messageId } = await makeGroupChannelMessage(b, owner, "public");

    for (const [signer, id] of [
      [owner, "o"],
      [bob, "b"],
    ] as const) {
      const conn = await connectAuthenticated(b, signer);
      await subscribe(conn, channelId);
      conn.send({
        id: `rx_${id}`,
        type: "reaction.add",
        ts: rfc3339Timestamp(),
        data: { groupId, channelId, messageId, key: "fire", unicode: "🔥" },
      });
      await conn.ofType("reaction.added");
      conn.close();
    }

    const items = await listReactionItems(b, owner, groupId, channelId, messageId);
    expect(items.length).toBe(2);
    const authors = new Set(items.map((r) => r.author));
    expect(authors).toEqual(new Set([owner.actor, bob.actor]));
    // All carry the same key → clients aggregate count = 2 for "fire".
    expect(items.every((r) => r.key === "fire")).toBe(true);
  });

  test("reaction.add to a channel the actor can't see → error forbidden", async () => {
    const b = boot("rx-forbidden");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob"); // not a member
    const { groupId, channelId, messageId } = await makeGroupChannelMessage(b, owner, "private");

    const bobConn = await connectAuthenticated(b, bob);
    bobConn.send({
      id: "rx_forbidden",
      type: "reaction.add",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId, key: "heart" },
    });
    const err = await bobConn.ofType("error");
    expect((err.data as { code: string }).code).toBe("forbidden");
    expect((err.data as { status: number }).status).toBe(403);
    expect(err.correlationId).toBe("rx_forbidden");
    bobConn.close();
  });

  test("reaction.add to a missing message → error not found", async () => {
    const b = boot("rx-missing");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannelMessage(b, alice, "public");

    const a = await connectAuthenticated(b, alice);
    a.send({
      id: "rx_missing",
      type: "reaction.add",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId: "msg_does_not_exist", key: "heart" },
    });
    const err = await a.ofType("error");
    expect((err.data as { status: number }).status).toBe(404);
    expect(err.correlationId).toBe("rx_missing");
    a.close();
  });
});

// ---------------------------------------------------------------------------
// REST reactions (§7.1 equivalents)
// ---------------------------------------------------------------------------

describe("REST reactions (§7.1 equivalents)", () => {
  test("PUT is idempotent (201 then 200) and reaches WS subscribers; DELETE → 204 + reaction.removed", async () => {
    const b = boot("rx-rest-parity");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId, messageId } = await makeGroupChannelMessage(b, alice, "public");

    // A subscriber that should see the hub fan-out from the REST path.
    const watcher = await connectAuthenticated(b, bob);
    await subscribe(watcher, channelId);

    const base = `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/reactions/heart`;

    // First PUT → 201 + the Reaction; WS subscriber sees reaction.added.
    const put1 = await signedReq(b, alice, "PUT", base, { unicode: "❤️" });
    expect(put1.status).toBe(201);
    const r1 = (await put1.json()) as Reaction;
    expect(r1.author).toBe(alice.actor);
    expect(r1.key).toBe("heart");
    expect(r1.reference).toEqual({ type: "message", id: messageId });

    const added = await watcher.ofType("reaction.added");
    expect((added.data as { reaction: Reaction }).reaction.id).toBe(r1.id);

    // Idempotent repeat → 200 + the SAME reaction id.
    const put2 = await signedReq(b, alice, "PUT", base, { unicode: "❤️" });
    expect(put2.status).toBe(200);
    expect(((await put2.json()) as Reaction).id).toBe(r1.id);

    const items = await listReactionItems(b, alice, groupId, channelId, messageId);
    expect(items.length).toBe(1);

    // DELETE → 204 + WS reaction.removed.
    const del = await signedReq(b, alice, "DELETE", base);
    expect(del.status).toBe(204);
    const removed = await watcher.ofType("reaction.removed");
    expect((removed.data as { key: string; author: string }).key).toBe("heart");
    expect((removed.data as { author: string }).author).toBe(alice.actor);

    expect((await listReactionItems(b, alice, groupId, channelId, messageId)).length).toBe(0);

    watcher.close();
  });

  test("GET …/reactions paginates", async () => {
    const b = boot("rx-rest-paginate");
    const owner = await registerUserWithKey(b, "owner");
    const u2 = await registerUserWithKey(b, "user2");
    const u3 = await registerUserWithKey(b, "user3");
    const { groupId, channelId, messageId } = await makeGroupChannelMessage(b, owner, "public");
    const path = `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/reactions`;

    // Three distinct users each react with a distinct key → three rows.
    for (const [signer, key] of [
      [owner, "a"],
      [u2, "b"],
      [u3, "c"],
    ] as const) {
      const res = await signedReq(b, signer, "PUT", `${path}/${key}`, {});
      expect(res.status).toBe(201);
    }

    // Page size 2 → first page has 2 + a nextCursor; following it yields the 3rd.
    const p1 = await signedReq(b, owner, "GET", `${path}?limit=2`);
    expect(p1.status).toBe(200);
    const page1 = (await p1.json()) as { items: Reaction[]; page: { nextCursor?: string } };
    expect(page1.items.length).toBe(2);
    expect(typeof page1.page.nextCursor).toBe("string");

    const p2 = await signedReq(
      b,
      owner,
      "GET",
      `${path}?limit=2&cursor=${encodeURIComponent(page1.page.nextCursor as string)}`,
    );
    expect(p2.status).toBe(200);
    const page2 = (await p2.json()) as { items: Reaction[]; page: { nextCursor?: string } };
    expect(page2.items.length).toBe(1);
    expect(page2.page.nextCursor).toBeUndefined();

    // No overlap, full coverage.
    const ids = [...page1.items, ...page2.items].map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("reading reactions on a private channel as a non-member → 403", async () => {
    const b = boot("rx-rest-private");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob"); // not a member
    const { groupId, channelId, messageId } = await makeGroupChannelMessage(b, owner, "private");

    const res = await signedReq(
      b,
      bob,
      "GET",
      `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/reactions`,
    );
    expect(res.status).toBe(403);
  });

  test("PUT a reaction in a private channel as a non-member → 403", async () => {
    const b = boot("rx-rest-put-private");
    const owner = await registerUserWithKey(b, "owner");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId, messageId } = await makeGroupChannelMessage(b, owner, "private");

    const res = await signedReq(
      b,
      bob,
      "PUT",
      `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/reactions/heart`,
      {},
    );
    expect(res.status).toBe(403);
  });
});
