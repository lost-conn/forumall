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
import { getDmConversationRow, storeDmMessage, upsertDmPointer } from "../src/provider/dms.ts";
import { signedProviderFetch } from "../src/provider/federation/http.ts";
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
  const app = createApp(config, { testOnlySkipReplayWarmup: true, db, wsTimings: FAST_TIMINGS });
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

    // alice reads the conversation → 200 with her SENT message (broadened read:
    // no sender copy is stored, but the read returns rows she authored that sit
    // in bob's inbox, §7.4).
    const aliceHist = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages`);
    expect(aliceHist.status).toBe(200);
    const aliceItems = ((await aliceHist.json()) as { items: { id: string; author: string }[] })
      .items;
    expect(aliceItems.length).toBe(1);
    expect(aliceItems[0]?.id).toBe(stored.id);
    expect(aliceItems[0]?.author).toBe(alice.actor);
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

  /**
   * The §7.1 idempotency guard `(owner, dmId, author, clientMessageId)` is what
   * makes a client RETRY safe: a send that committed but whose acknowledgement
   * was lost (aborted fetch / network drop / 5xx) is re-sent under the SAME id,
   * and the recipient must end up with exactly ONE message — the first one,
   * unchanged — rather than a duplicate delivery.
   */
  test("idempotency: same clientMessageId twice → one stored row, the FIRST message", async () => {
    const b = boot("dm-idempotent");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const r1 = await sendDm(b, alice, dmId, "once", "cmsg_dup");
    expect(r1.status).toBe(201);
    const first = (await r1.json()) as { id: string; createdAt: string };

    // The retry replays the same key. Different text on purpose: the guard must
    // return the STORED message, not re-store or overwrite it with the re-send.
    const r2 = await sendDm(b, alice, dmId, "once-again", "cmsg_dup");
    // Duplicate returns the existing stored message (200), unchanged.
    expect(r2.status).toBe(200);
    const second = (await r2.json()) as {
      id: string;
      createdAt: string;
      content: { text: string };
    };
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.content.text).toBe("once");

    // Exactly one row in bob's inbox, still carrying the first delivery's content.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
      .items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(first.id);
    expect(items[0]?.content.text).toBe("once");

    // …and the author's broadened read (§7.4) sees the single message too — no
    // second copy surfaces on the sender's side either.
    const mine = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages`);
    const mineItems = ((await mine.json()) as { items: { id: string }[] }).items;
    expect(mineItems.length).toBe(1);
    expect(mineItems[0]?.id).toBe(first.id);
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

describe("DM delivery `to` + conversation pointers (§7.4)", () => {
  test("delivery naming `to` is accepted; a `to` that does not match {dmId} → 400", async () => {
    const b = boot("dm-to");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await registerUserWithKey(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const ok = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "to-1",
      to: bob.actor,
      content: { mime: "text/plain", text: "hi bob" },
    });
    expect(ok.status).toBe(201);

    // carol is a real local user, but {dmId} is alice↔bob → refused.
    const bad = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "to-2",
      to: `carol@${DOMAIN}`,
      content: { mime: "text/plain", text: "misaddressed" },
    });
    expect(bad.status).toBe(400);
  });

  test("PUT /api/me/dms/{dmId} records a pointer to a remote conversation", async () => {
    const b = boot("dm-pointer");
    const alice = await registerUserWithKey(b, "alice");
    const remote = "dave@remote.example";
    const dmId = deriveDmId(alice.actor, remote);
    const sent = {
      id: "msg_remote1",
      author: alice.actor,
      type: "message",
      content: { mime: "text/plain", text: "hello over there" },
      attachments: [],
      createdAt: "2026-02-01T10:00:00Z",
      metadata: [],
    };

    const put = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: remote,
      lastMessage: sent,
    });
    expect(put.status).toBe(200);
    const conv = (await put.json()) as { id: string; participants: string[] };
    expect(conv.id).toBe(dmId);
    expect(conv.participants).toEqual([alice.actor, remote]);

    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    const items = ((await list.json()) as { items: { id: string; lastMessage?: { id: string } }[] })
      .items;
    expect(items.map((i) => i.id)).toEqual([dmId]);
    expect(items[0]?.lastMessage?.id).toBe("msg_remote1");

    // {dmId} not derived from (caller, with) → 400.
    const mismatch = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: "erin@remote.example",
    });
    expect(mismatch.status).toBe(400);
    // A preview authored by someone else → 400.
    const forged = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: remote,
      lastMessage: { ...sent, author: remote },
    });
    expect(forged.status).toBe(400);
  });
});

describe("DM conversation pointers: input + federation policy hardening (§7.4, §8)", () => {
  test("PUT rejects a URI or non-canonical `with` (400, never 500)", async () => {
    const b = boot("dm-pointer-canon");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, "dave@remote.example");

    for (const bad of [
      "https://remote.example/u/dave",
      "DAVE@remote.example",
      "dave@Remote.Example",
    ]) {
      const res = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, { with: bad });
      expect(res.status).toBe(400);
    }
    // Nothing was recorded.
    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test("upsertDmPointer never rewrites the counterparty of an existing row", async () => {
    const b = boot("dm-pointer-no-overwrite");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    await sendDm(b, bob, dmId, "hi alice", "cmsg_x"); // alice's inbox row, counterparty = bob

    // Even if a differently-spelled counterparty reached the upsert, the
    // verified participant on the existing row is kept.
    upsertDmPointer(b.db, "alice", dmId, bob.actor.toUpperCase());
    expect(getDmConversationRow(b.db, "alice", dmId)?.counterparty).toBe(bob.actor);
  });

  test("PUT refuses a counterparty on a deny-listed provider (403)", async () => {
    const b = boot("dm-pointer-deny", { FEDERATION_DENY: "evil.example" });
    const alice = await registerUserWithKey(b, "alice");
    const remote = "x@evil.example";
    const dmId = deriveDmId(alice.actor, remote);

    const res = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, { with: remote });
    expect(res.status).toBe(403);
    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test("outbound provider-signed calls never reach a deny-listed provider", async () => {
    const b = boot("dm-outbound-deny", { FEDERATION_DENY: "evil.example" });
    let calls = 0;
    const stub = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as Parameters<typeof signedProviderFetch>[3];

    const res = await signedProviderFetch(
      b.db,
      b.config,
      { method: "PUT", url: "https://evil.example/api/federation/dms/x/reactions/y" },
      stub,
    );
    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });
});

describe("DM conversation preview: newer by provider-recorded time (§7.4)", () => {
  const REMOTE = "dave@remote.example";

  /** A pointer preview alice "sent", with a client-chosen `createdAt`. */
  function preview(alice: Signer, id: string, createdAt: string) {
    return {
      id,
      author: alice.actor,
      type: "message",
      content: { mime: "text/plain", text: id },
      attachments: [],
      createdAt,
      metadata: [],
    };
  }

  /** Store a message from the remote party in alice's inbox; return its id. */
  function receive(b: Booted, dmId: string, text: string): string {
    return storeDmMessage(b.db, b.config, {
      owner: "alice",
      dmId,
      author: REMOTE,
      content: { mime: "text/plain", text },
    }).message.id;
  }

  async function previewId(b: Booted, alice: Signer, dmId: string): Promise<string | undefined> {
    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    const items = ((await list.json()) as { items: { id: string; lastMessage?: { id: string } }[] })
      .items;
    return items.find((i) => i.id === dmId)?.lastMessage?.id;
  }

  async function putPointer(b: Booted, alice: Signer, dmId: string, lastMessage?: unknown) {
    const res = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: REMOTE,
      ...(lastMessage !== undefined ? { lastMessage } : {}),
    });
    expect(res.status).toBe(200);
  }

  /** Let the clock tick so successive provider store times are distinct. */
  const tick = () => Bun.sleep(3);

  test("a forged far-future preview createdAt doesn't beat a later-stored received message", async () => {
    const b = boot("dm-preview-forged");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);

    await putPointer(b, alice, dmId, preview(alice, "msg_forged", "2099-01-01T00:00:00Z"));
    await tick();
    const received = receive(b, dmId, "newer, really");
    expect(await previewId(b, alice, dmId)).toBe(received);
  });

  test("a preview stored later wins even with an old createdAt; a PUT without lastMessage changes nothing", async () => {
    const b = boot("dm-preview-touch");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);

    receive(b, dmId, "first");
    await tick();
    // Stored after the received message, though its (client) createdAt is old.
    await putPointer(b, alice, dmId, preview(alice, "msg_sent", "2020-01-01T00:00:00Z"));
    expect(await previewId(b, alice, dmId)).toBe("msg_sent");
    await tick();
    await putPointer(b, alice, dmId); // touch only
    expect(await previewId(b, alice, dmId)).toBe("msg_sent");

    await tick();
    const received = receive(b, dmId, "second");
    expect(await previewId(b, alice, dmId)).toBe(received);
    await tick();
    await putPointer(b, alice, dmId); // touch only — bumps updatedAt, not the preview time
    expect(await previewId(b, alice, dmId)).toBe(received);
  });

  test("re-PUTting the same preview keeps its original store time", async () => {
    const b = boot("dm-preview-replay");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);

    const old = preview(alice, "msg_old", "2026-01-01T00:00:00Z");
    await putPointer(b, alice, dmId, old);
    const storedAt = getDmConversationRow(b.db, "alice", dmId)?.lastSentAt;
    await tick();
    const reply = receive(b, dmId, "newer reply");
    await tick();
    // A retried/replayed PUT of the same message must not re-stamp it.
    await putPointer(b, alice, dmId, old);
    expect(getDmConversationRow(b.db, "alice", dmId)?.lastSentAt).toBe(storedAt);
    expect(await previewId(b, alice, dmId)).toBe(reply);

    // A genuinely new message is stamped now and wins.
    await tick();
    await putPointer(b, alice, dmId, preview(alice, "msg_new", "2026-01-01T00:00:00Z"));
    expect(await previewId(b, alice, dmId)).toBe("msg_new");
  });

  test("on a tie the received message wins", async () => {
    const b = boot("dm-preview-tie");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);

    const received = receive(b, dmId, "received");
    await putPointer(b, alice, dmId, preview(alice, "msg_sent", "2099-01-01T00:00:00Z"));
    // Force identical provider store times.
    b.db.sqlite
      .query(
        "UPDATE dm_conversations SET last_sent_at = (SELECT created_at FROM dm_messages WHERE id = ?) WHERE owner = 'alice' AND dm_id = ?",
      )
      .run(received, dmId);
    expect(await previewId(b, alice, dmId)).toBe(received);
  });

  test("a legacy preview with no store time loses to any received message", async () => {
    const b = boot("dm-preview-legacy");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);
    const clearTime = () =>
      b.db.sqlite
        .query("UPDATE dm_conversations SET last_sent_at = NULL WHERE owner = 'alice'")
        .run();

    // With an empty inbox the legacy preview is still shown.
    await putPointer(b, alice, dmId, preview(alice, "msg_legacy", "2099-01-01T00:00:00Z"));
    clearTime();
    expect(getDmConversationRow(b.db, "alice", dmId)?.lastSentAt).toBeNull();
    expect(await previewId(b, alice, dmId)).toBe("msg_legacy");

    // Once anything is received, the received message wins.
    const received = receive(b, dmId, "received");
    expect(await previewId(b, alice, dmId)).toBe(received);
  });

  test("a forged preview time doesn't reorder the conversation list", async () => {
    const b = boot("dm-preview-order");
    const alice = await registerUserWithKey(b, "alice");
    const forgedDm = deriveDmId(alice.actor, REMOTE);
    const otherRemote = "erin@remote.example";
    const otherDm = deriveDmId(alice.actor, otherRemote);

    await putPointer(b, alice, forgedDm, preview(alice, "msg_forged", "2099-01-01T00:00:00Z"));
    await tick();
    storeDmMessage(b.db, b.config, {
      owner: "alice",
      dmId: otherDm,
      author: otherRemote,
      content: { mime: "text/plain", text: "latest activity" },
    });
    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    const ids = ((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toEqual([otherDm, forgedDm]);
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

    // alice keeps no sender COPY, but her home provider (this one) records a
    // conversation POINTER (§7.4) so the conversation she started lists for her,
    // previewing her own last sent message.
    const aliceList = await signedReq(b, alice, "GET", "/api/me/dms");
    const aliceItems = (
      (await aliceList.json()) as {
        items: { id: string; lastMessage?: { author: string; content: { text: string } } }[];
      }
    ).items;
    expect(aliceItems.length).toBe(1);
    expect(aliceItems[0]?.id).toBe(dmId);
    expect(aliceItems[0]?.lastMessage?.author).toBe(alice.actor);
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

describe("DM broadened read: sender can read back their sent messages (§7.4)", () => {
  test("both A and B see the full conversation (sent ∪ received), ordered by seq", async () => {
    const b = boot("dm-broadened-both");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice → bob, then bob → alice (interleaved authorship).
    const s1 = await sendDm(b, alice, dmId, "from alice 1", "c1");
    const s2 = await sendDm(b, bob, dmId, "from bob 1", "c2");
    const s3 = await sendDm(b, alice, dmId, "from alice 2", "c3");
    const id1 = ((await s1.json()) as { id: string }).id;
    const id2 = ((await s2.json()) as { id: string }).id;
    const id3 = ((await s3.json()) as { id: string }).id;

    // alice reads (forward = chronological): sees all three, hers + bob's.
    const aRes = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages?direction=forward`);
    expect(aRes.status).toBe(200);
    const aItems = ((await aRes.json()) as { items: { id: string; author: string }[] }).items;
    expect(aItems.map((m) => m.id)).toEqual([id1, id2, id3]);
    expect(aItems.map((m) => m.author)).toEqual([alice.actor, bob.actor, alice.actor]);

    // bob reads (forward): sees the same three in the same seq order.
    const bRes = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages?direction=forward`);
    expect(bRes.status).toBe(200);
    const bItems = ((await bRes.json()) as { items: { id: string; author: string }[] }).items;
    expect(bItems.map((m) => m.id)).toEqual([id1, id2, id3]);
  });

  test("a sender who has ONLY sent (no received) can read their sent message back", async () => {
    const b = boot("dm-broadened-onlysent");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await sendDm(b, alice, dmId, "only sent", "c_only");
    const id = ((await sent.json()) as { id: string }).id;

    // alice has no inbox row of her own for dmId, but is the counterparty of
    // bob's inbox row → participant; the read returns her sent message.
    const res = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: { id: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(id);
  });

  test("a genuine non-participant still gets 404", async () => {
    const b = boot("dm-broadened-nonparticipant");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    await sendDm(b, alice, dmId, "private", "c_priv");

    const res = await signedReq(b, carol, "GET", `/api/dms/${dmId}/messages`);
    expect(res.status).toBe(404);
  });

  test("replies read is scoped the same way (sent replies show too)", async () => {
    const b = boot("dm-broadened-replies");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice sends a parent, then alice replies to it (the reply is authored by
    // alice and stored in bob's inbox — no sender copy).
    const parent = await sendDm(b, alice, dmId, "parent", "c_parent");
    const parentId = ((await parent.json()) as { id: string }).id;
    const reply = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "c_reply",
      content: { mime: "text/plain", text: "my reply" },
      reference: { type: "reply", id: parentId },
    });
    const replyId = ((await reply.json()) as { id: string }).id;

    // alice lists the replies to her parent → sees her own sent reply.
    const res = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages/${parentId}/replies`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: { id: string }[] }).items;
    expect(items.map((m) => m.id)).toEqual([replyId]);
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
