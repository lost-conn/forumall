/**
 * Inbound notifications-feed tests (a provider-LOCAL extension — @mentions +
 * thread-replies on a group CHANNEL; distinct from the §10 outbound webhooks).
 *
 * Covers:
 *  - Detection: a mention of a LOCAL user creates a `mention` row.
 *  - Self-mention is excluded.
 *  - A remote / unknown `@handle` creates NO row (local-recipient-only boundary).
 *  - A reply to a LOCAL user's message creates a `reply` row.
 *  - A reply to your OWN message is excluded.
 *  - `GET /api/me/notifications` paging + `type` filter.
 *  - mark-seen / mark-read keep SEPARATE state, are idempotent + recipient-scoped.
 *  - `notification.created` is fanned to the recipient's WS connection (real
 *    `Bun.serve` + `new WebSocket`, no mocks).
 *
 * The message-create + fan-out path is exercised over the real signed WebSocket
 * (the only path that creates channel messages), so the WS hook is covered too.
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
import { type Db, openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { createChannel } from "../src/provider/channels.ts";
import { addMember } from "../src/provider/membership.ts";
import { createMessage } from "../src/provider/messages.ts";
import {
  detectMentions,
  listNotifications,
  markRead,
  markSeen,
  notifyForChannelMessage,
  unreadCounts,
} from "../src/provider/notifications-feed.ts";

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
  tmp = mkdtempSync(join(tmpdir(), "forumall-notif-"));
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
  fullPath: string,
  bodyObj?: unknown,
): Promise<Response> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  // Split the query off so the canonical string (§4.4.2) signs `path` + `query`
  // as separate lines, exactly as the server reconstructs them.
  const q = fullPath.indexOf("?");
  const path = q === -1 ? fullPath : fullPath.slice(0, q);
  const query = q === -1 ? undefined : fullPath.slice(q + 1);
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
  return http(b, fullPath, {
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

/** Post `text` from `author` in `(groupId, channelId)`; return the message id. */
function post(
  b: Booted,
  groupId: string,
  channelId: string,
  author: string,
  text: string,
  replyTo?: string,
): string {
  return createMessage(b.db, b.config, {
    groupId,
    channelId,
    author,
    type: "message",
    content: { text, mime: "text/plain" },
    ...(replyTo ? { reference: { type: "reply", id: replyTo } } : {}),
  }).message.id;
}

// ---------------------------------------------------------------------------
// detectMentions
// ---------------------------------------------------------------------------

describe("detectMentions", () => {
  test("parses bare and explicit mentions, stops at punctuation", () => {
    const out = detectMentions("hey @alice, and @bob@other.com plus @carol!", DOMAIN);
    expect(out).toEqual([`alice@${DOMAIN}`, "bob@other.com", `carol@${DOMAIN}`]);
  });

  test("does not match an email address in prose", () => {
    // `a@b.com` — the `@` is preceded by a word char, so no bare mention of b.com.
    const out = detectMentions("mail me at jane@example.com sometime", DOMAIN);
    expect(out).toEqual([]);
  });

  test("dedupes repeated mentions", () => {
    const out = detectMentions("@alice @alice @alice", DOMAIN);
    expect(out).toEqual([`alice@${DOMAIN}`]);
  });
});

// ---------------------------------------------------------------------------
// Provider: notifyForChannelMessage (detection + persistence rules)
// ---------------------------------------------------------------------------

describe("notifyForChannelMessage", () => {
  test("a mention of a local user creates a mention row; self-mention excluded", async () => {
    const b = boot("nf-mention");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    // bob mentions alice AND himself; only the alice row is created.
    const msgId = post(b, groupId, ch.id, bob.actor, "hi @alice and @bob");
    const created = notifyForChannelMessage(b.db, {
      text: "hi @alice and @bob",
      author: bob.actor,
      sourceMessageId: msgId,
      channelId: ch.id,
      groupId,
      localDomain: DOMAIN,
    });
    expect(created.length).toBe(1);
    expect(created[0]?.recipient).toBe("alice");
    expect(created[0]?.notification.type).toBe("mention");

    const page = listNotifications(b.db, "alice");
    expect(page.items.length).toBe(1);
    // bob got nothing (self-mention excluded).
    expect(listNotifications(b.db, "bob").items.length).toBe(0);
  });

  test("a remote/unknown @handle creates no row", async () => {
    const b = boot("nf-remote");
    const alice = await registerUserWithKey(b, "alice");
    const groupId = seedGroup(b, alice);
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    const msgId = post(b, groupId, ch.id, alice.actor, "yo @ghost and @someone@remote.example");
    const created = notifyForChannelMessage(b.db, {
      text: "yo @ghost and @someone@remote.example",
      author: alice.actor,
      sourceMessageId: msgId,
      channelId: ch.id,
      groupId,
      localDomain: DOMAIN,
    });
    // `ghost` is not a local user; `someone@remote.example` is remote → both skipped.
    expect(created.length).toBe(0);
  });

  test("a reply to a local user's message creates a reply row; reply to own excluded", async () => {
    const b = boot("nf-reply");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    const parent = post(b, groupId, ch.id, alice.actor, "the original");

    // bob replies to alice → alice gets a reply notification.
    const reply = post(b, groupId, ch.id, bob.actor, "good point", parent);
    const created = notifyForChannelMessage(b.db, {
      text: "good point",
      author: bob.actor,
      sourceMessageId: reply,
      channelId: ch.id,
      groupId,
      localDomain: DOMAIN,
      replyToId: parent,
    });
    expect(created.length).toBe(1);
    expect(created[0]?.recipient).toBe("alice");
    expect(created[0]?.notification.type).toBe("reply");

    // alice replies to her OWN message → no notification.
    const selfReply = post(b, groupId, ch.id, alice.actor, "and one more", parent);
    const created2 = notifyForChannelMessage(b.db, {
      text: "and one more",
      author: alice.actor,
      sourceMessageId: selfReply,
      channelId: ch.id,
      groupId,
      localDomain: DOMAIN,
      replyToId: parent,
    });
    expect(created2.length).toBe(0);
  });

  test("dedupes a single message that mentions the same user twice", async () => {
    const b = boot("nf-dedupe");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    const msgId = post(b, groupId, ch.id, bob.actor, "@alice @alice hello");
    const created = notifyForChannelMessage(b.db, {
      text: "@alice @alice hello",
      author: bob.actor,
      sourceMessageId: msgId,
      channelId: ch.id,
      groupId,
      localDomain: DOMAIN,
    });
    expect(created.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HTTP: GET feed (paging + type filter), POST seen/read
// ---------------------------------------------------------------------------

/** Seed `count` mention notifications for `recipient` from `author`. */
function seedMentions(
  b: Booted,
  groupId: string,
  channelId: string,
  author: string,
  recipientHandle: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const msgId = post(b, groupId, channelId, author, `@${recipientHandle} ${i}`);
    notifyForChannelMessage(b.db, {
      text: `@${recipientHandle} ${i}`,
      author,
      sourceMessageId: msgId,
      channelId,
      groupId,
      localDomain: DOMAIN,
    });
  }
}

describe("GET/POST /api/me/notifications", () => {
  test("GET returns newest-first feed with paging + type filter + counts", async () => {
    const b = boot("nf-http-get");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    seedMentions(b, groupId, ch.id, bob.actor, "alice", 3);
    // Plus a reply notification for alice.
    const parent = post(b, groupId, ch.id, alice.actor, "root");
    const reply = post(b, groupId, ch.id, bob.actor, "re", parent);
    notifyForChannelMessage(b.db, {
      text: "re",
      author: bob.actor,
      sourceMessageId: reply,
      channelId: ch.id,
      groupId,
      localDomain: DOMAIN,
      replyToId: parent,
    });

    // Page 1 (limit 2).
    const r1 = await signedReq(b, alice, "GET", "/api/me/notifications?limit=2");
    expect(r1.status).toBe(200);
    const p1 = (await r1.json()) as {
      items: { id: string; type: string; createdAt: string }[];
      counts: { mention: number; reply: number };
      nextCursor?: string;
    };
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).toBeDefined();
    expect(p1.counts.mention).toBe(3);
    expect(p1.counts.reply).toBe(1);

    // Page 2 via cursor.
    const r2 = await signedReq(
      b,
      alice,
      "GET",
      `/api/me/notifications?limit=2&cursor=${encodeURIComponent(p1.nextCursor as string)}`,
    );
    const p2 = (await r2.json()) as { items: { id: string }[] };
    expect(p2.items.length).toBe(2);
    // No overlap between pages.
    const ids1 = new Set(p1.items.map((i) => i.id));
    expect(p2.items.every((i) => !ids1.has(i.id))).toBe(true);

    // type=reply filters to the single reply.
    const rReply = await signedReq(b, alice, "GET", "/api/me/notifications?type=reply");
    const pReply = (await rReply.json()) as { items: { type: string }[] };
    expect(pReply.items.length).toBe(1);
    expect(pReply.items[0]?.type).toBe("reply");
  });

  test("mark-seen and mark-read keep separate state, idempotent + scoped", async () => {
    const b = boot("nf-mark");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    seedMentions(b, groupId, ch.id, bob.actor, "alice", 2);
    // bob also has a mention from alice, to test recipient-scoping.
    const bm = post(b, groupId, ch.id, alice.actor, "@bob hey");
    notifyForChannelMessage(b.db, {
      text: "@bob hey",
      author: alice.actor,
      sourceMessageId: bm,
      channelId: ch.id,
      groupId,
      localDomain: DOMAIN,
    });

    // Mark all of alice's seen.
    const seen = await signedReq(b, alice, "POST", "/api/me/notifications/seen", {});
    expect(seen.status).toBe(200);
    const seenBody = (await seen.json()) as {
      affected: number;
      counts: { mention: number };
    };
    expect(seenBody.affected).toBe(2);
    expect(seenBody.counts.mention).toBe(0); // unseen count now zero

    // Idempotent: a second mark-all-seen touches nothing.
    const seen2 = await signedReq(b, alice, "POST", "/api/me/notifications/seen", {});
    expect(((await seen2.json()) as { affected: number }).affected).toBe(0);

    // bob's notification is untouched (recipient-scoped).
    expect(unreadCounts(b.db, "bob").mention).toBe(1);

    // The feed now shows seenAt set but readAt absent (separate state).
    const feed = await signedReq(b, alice, "GET", "/api/me/notifications");
    const feedBody = (await feed.json()) as {
      items: { seenAt?: string; readAt?: string }[];
    };
    expect(feedBody.items.every((i) => i.seenAt && !i.readAt)).toBe(true);

    // Mark one specific notification read → that one gets readAt; the other stays unread.
    const allIds = (
      (await (await signedReq(b, alice, "GET", "/api/me/notifications")).json()) as {
        items: { id: string }[];
      }
    ).items;
    const read = await signedReq(b, alice, "POST", "/api/me/notifications/read", {
      ids: [allIds[0]?.id],
    });
    expect(((await read.json()) as { affected: number }).affected).toBe(1);

    const after = (
      (await (await signedReq(b, alice, "GET", "/api/me/notifications")).json()) as {
        items: { id: string; readAt?: string }[];
      }
    ).items;
    const readCount = after.filter((i) => i.readAt).length;
    expect(readCount).toBe(1);
  });

  test("read implies seen (marking an unseen row read stamps seen too)", async () => {
    const b = boot("nf-read-implies-seen");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const groupId = seedGroup(b, alice);
    addMember(b.db, groupId, bob.actor, "member");
    const ch = createChannel(b.db, groupId, { type: "text", tier: "private" });

    seedMentions(b, groupId, ch.id, bob.actor, "alice", 1);
    const before = listNotifications(b.db, "alice").items[0];
    expect(before?.seenAt).toBeUndefined();
    expect(before?.readAt).toBeUndefined();

    // Mark read WITHOUT marking seen first → both timestamps get set.
    const affected = markRead(b.db, "alice");
    expect(affected).toBe(1);
    const after = listNotifications(b.db, "alice").items[0];
    expect(after?.readAt).toBeDefined();
    expect(after?.seenAt).toBeDefined();
    // Unseen count drops to 0 (read implies seen).
    expect(unreadCounts(b.db, "alice").mention).toBe(0);

    // markSeen alone is also idempotent now (nothing unseen).
    expect(markSeen(b.db, "alice")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WS: notification.created fan-out to the recipient's connection
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

/**
 * Create a group owned by `owner` + a `public`-tier text channel via the real
 * signed API (so the group carries a permissions map and a non-member can post to
 * the public channel) — mirrors the ws.test.ts helper.
 */
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

describe("notification.created WS fan-out", () => {
  test("a channel message mentioning bob fans notification.created to bob's WS", async () => {
    const b = boot("nf-ws");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    // alice owns the group + channel (the owner can post). bob is a LOCAL user →
    // an eligible mention recipient.
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    // bob connects (the fan-out is publishToActor — he need not subscribe).
    const bobWs = await connectAuthenticated(b, bob);

    // alice connects + subscribes (so she receives her own author copy) + posts a
    // channel message mentioning bob.
    const aliceWs = await connectAuthenticated(b, alice);
    aliceWs.send({
      id: "cli_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    await aliceWs.ofType("subscribed");
    aliceWs.send({
      id: "cli_msg",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        content: { text: "hey @bob look here", mime: "text/plain" },
      },
    });
    // Confirm the post itself landed (alice sees her own message.created).
    await aliceWs.ofType("message.created");

    // bob receives notification.created with a mention notification.
    const evt = await bobWs.ofType("notification.created");
    const data = evt.data as { notification: { type: string; author: string; channelId: string } };
    expect(data.notification.type).toBe("mention");
    expect(data.notification.author).toBe(alice.actor);
    expect(data.notification.channelId).toBe(channelId);

    aliceWs.close();
    bobWs.close();
  });
});
