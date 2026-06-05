/**
 * Message edit + delete (tombstone) tests (spec §7.1 "Editing & deleting
 * messages") — both the WS commands (`message.update` / `message.delete`) and
 * the REST equivalents (`PATCH` / `DELETE`), exercised against a REAL server so
 * REST mutations can be observed reaching a subscribed WS client through the hub.
 *
 * Covers:
 *  - edit within the window by the author → `editedAt` set + `message.updated`
 *    fanned out; edit after `edit_until` → 403, no change; non-author edit → 403;
 *  - delete by the author → tombstone (id kept, content cleared, `deletedAt` set)
 *    + `message.deleted`, still present (as a tombstone) in REST history;
 *  - delete by a non-author non-moderator → 403; by a moderator (not author) →
 *    204/tombstone;
 *  - REST PATCH/DELETE behave identically AND reach a subscribed WS client.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  MessageSchema,
  type WsEnvelope,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signWsAuthenticate,
} from "@forumall/shared";
import { eq } from "drizzle-orm";

import { type AppWithWebSocket, createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { groupMembers, messages } from "../src/db/schema.ts";
import { createMessage } from "../src/provider/messages.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

const FAST_TIMINGS = {
  authTimeoutMs: 1000,
  challengeTtlMs: 10_000,
  pingIntervalMs: 5_000,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-msg-edit-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Booted {
  app: AppWithWebSocket;
  db: ReturnType<typeof openDb>;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
  url: string;
}

const booted: Booted[] = [];

/** Boot the app on an ephemeral port with a real WS server. */
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
  const b: Booted = { app, db, config, server, url };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

// ---------------------------------------------------------------------------
// HTTP helpers.
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

/** Insert a membership row directly (membership card owns the real join flow). */
function addMember(b: Booted, groupId: string, signer: Signer, role: string): void {
  b.db.drizzle
    .insert(groupMembers)
    .values({ groupId, user: signer.actor, role, joinedAt: Date.now() })
    .run();
}

/** Seed one message authored by `author` and return its id. */
function seedMessage(
  b: Booted,
  groupId: string,
  channelId: string,
  author: string,
  text = "hello",
): string {
  return createMessage(b.db, b.config, {
    channelId,
    groupId,
    author,
    type: "message",
    content: { text, mime: "text/plain" },
  }).message.id;
}

// ---------------------------------------------------------------------------
// Tiny WS client (queues frames, await-by-predicate).
// ---------------------------------------------------------------------------

class WsClient {
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

  close(): void {
    this.ws.close();
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

async function subscribe(client: WsClient, channelId: string): Promise<void> {
  client.send({
    id: "sub",
    type: "subscribe",
    ts: rfc3339Timestamp(),
    data: { channels: [channelId] },
  });
  await client.ofType("subscribed");
}

/** Read the current stored row (raw) for assertions. */
function row(b: Booted, messageId: string) {
  return b.db.drizzle.select().from(messages).where(eq(messages.id, messageId)).all()[0];
}

// ===========================================================================
// WS path
// ===========================================================================

describe("WS message.update (§7.1 edit)", () => {
  test("author edits within window → editedAt set + message.updated fanned out", async () => {
    const b = boot("ws-edit-ok");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const messageId = seedMessage(b, groupId, channelId, alice.actor, "first");

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId);
    await subscribe(bConn, channelId);

    a.send({
      id: "cli_edit",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId, content: { mime: "text/plain", text: "edited!" } },
    });

    const aEvt = await a.ofType("message.updated");
    const bEvt = await bConn.ofType("message.updated");
    expect(aEvt.correlationId).toBe("cli_edit");

    const msg = MessageSchema.parse((aEvt.data as { message: unknown }).message);
    expect(msg.id).toBe(messageId);
    expect(msg.content.text).toBe("edited!");
    expect(msg.editedAt).toBeDefined();
    expect((bEvt.data as { message: { content: { text: string } } }).message.content.text).toBe(
      "edited!",
    );

    expect(row(b, messageId)?.editedAt).not.toBeNull();
    a.close();
    bConn.close();
  });

  test("edit after edit_until → 403, no change", async () => {
    const b = boot("ws-edit-late");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const messageId = seedMessage(b, groupId, channelId, alice.actor, "orig");
    // Push the row's edit window into the past.
    b.db.drizzle
      .update(messages)
      .set({ editUntil: Date.now() - 1000 })
      .where(eq(messages.id, messageId))
      .run();

    const a = await connectAuthenticated(b, alice);
    await subscribe(a, channelId);
    a.send({
      id: "cli_edit_late",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId, content: { mime: "text/plain", text: "nope" } },
    });

    const err = await a.ofType("error");
    expect((err.data as { status: number }).status).toBe(403);
    expect(err.correlationId).toBe("cli_edit_late");
    expect(JSON.parse(row(b, messageId)?.content ?? "{}").text).toBe("orig");
    a.close();
  });

  test("edit by a non-author → 403", async () => {
    const b = boot("ws-edit-nonauthor");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const messageId = seedMessage(b, groupId, channelId, alice.actor, "alice's");

    const bConn = await connectAuthenticated(b, bob);
    await subscribe(bConn, channelId);
    bConn.send({
      id: "cli_edit_bob",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId, content: { mime: "text/plain", text: "hijack" } },
    });

    const err = await bConn.ofType("error");
    expect((err.data as { status: number }).status).toBe(403);
    expect(JSON.parse(row(b, messageId)?.content ?? "{}").text).toBe("alice's");
    bConn.close();
  });

  test("update a missing message → 404", async () => {
    const b = boot("ws-edit-404");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const a = await connectAuthenticated(b, alice);
    await subscribe(a, channelId);
    a.send({
      id: "cli_edit_missing",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        messageId: "msg_nope",
        content: { mime: "text/plain", text: "x" },
      },
    });
    const err = await a.ofType("error");
    expect((err.data as { status: number }).status).toBe(404);
    a.close();
  });
});

describe("WS message.delete (§7.1 tombstone)", () => {
  test("author deletes → tombstone + message.deleted; still in history", async () => {
    const b = boot("ws-del-author");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const messageId = seedMessage(b, groupId, channelId, alice.actor, "to delete");
    const beforeSeq = row(b, messageId)?.seq;

    const a = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(a, channelId);
    await subscribe(bConn, channelId);

    a.send({
      id: "cli_del",
      type: "message.delete",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId },
    });

    const aEvt = await a.ofType("message.deleted");
    const bEvt = await bConn.ofType("message.deleted");
    expect((aEvt.data as { messageId: string }).messageId).toBe(messageId);
    expect(typeof (aEvt.data as { deletedAt: string }).deletedAt).toBe("string");
    expect((bEvt.data as { messageId: string }).messageId).toBe(messageId);

    // Tombstone: id + seq kept, content cleared, deletedAt set.
    const r = row(b, messageId);
    expect(r?.id).toBe(messageId);
    expect(r?.seq).toBe(beforeSeq);
    expect(r?.deletedAt).not.toBeNull();
    expect(JSON.parse(r?.content ?? "{}").text).toBe("");

    // Still appears in REST history (as a tombstone) and paginates over it.
    const hist = await signedReq(
      b,
      alice,
      "GET",
      `/api/groups/${groupId}/channels/${channelId}/messages`,
    );
    expect(hist.status).toBe(200);
    const items = ((await hist.json()) as { items: { id: string; deletedAt?: string }[] }).items;
    const found = items.find((m) => m.id === messageId);
    expect(found).toBeDefined();
    expect(found?.deletedAt).toBeDefined();

    a.close();
    bConn.close();
  });

  test("delete by a non-author non-moderator → 403", async () => {
    const b = boot("ws-del-forbidden");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const messageId = seedMessage(b, groupId, channelId, alice.actor);
    // bob is a plain member (no moderate).
    addMember(b, groupId, bob, "guest");

    const bConn = await connectAuthenticated(b, bob);
    await subscribe(bConn, channelId);
    bConn.send({
      id: "cli_del_bob",
      type: "message.delete",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId },
    });
    const err = await bConn.ofType("error");
    expect((err.data as { status: number }).status).toBe(403);
    expect(row(b, messageId)?.deletedAt).toBeNull();
    bConn.close();
  });

  test("delete by a moderator (not author) → tombstone", async () => {
    const b = boot("ws-del-mod");
    const alice = await registerUserWithKey(b, "alice");
    const mod = await registerUserWithKey(b, "mod");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const messageId = seedMessage(b, groupId, channelId, alice.actor);
    // admin holds `moderate` by rank-inheritance (default permissions list member).
    addMember(b, groupId, mod, "admin");

    const m = await connectAuthenticated(b, mod);
    await subscribe(m, channelId);
    m.send({
      id: "cli_del_mod",
      type: "message.delete",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId },
    });
    const evt = await m.ofType("message.deleted");
    expect((evt.data as { messageId: string }).messageId).toBe(messageId);
    expect(row(b, messageId)?.deletedAt).not.toBeNull();
    m.close();
  });
});

// ===========================================================================
// REST path — identical rules, and reaches WS subscribers via the hub.
// ===========================================================================

describe("REST PATCH/DELETE messages (§7.1 equivalents)", () => {
  test("PATCH edits, returns 200 updated Message, and reaches a WS subscriber", async () => {
    const b = boot("rest-patch");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const messageId = seedMessage(b, groupId, channelId, alice.actor, "before");

    // A WS subscriber that should receive the REST-originated message.updated.
    const watcher = await connectAuthenticated(b, alice);
    await subscribe(watcher, channelId);

    const res = await signedReq(
      b,
      alice,
      "PATCH",
      `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}`,
      { content: { mime: "text/plain", text: "after" } },
    );
    expect(res.status).toBe(200);
    const updated = MessageSchema.parse(await res.json());
    expect(updated.content.text).toBe("after");
    expect(updated.editedAt).toBeDefined();

    const evt = await watcher.ofType("message.updated");
    expect((evt.data as { message: { content: { text: string } } }).message.content.text).toBe(
      "after",
    );
    watcher.close();
  });

  test("PATCH after window → 403; PATCH by non-author → 403; missing → 404", async () => {
    const b = boot("rest-patch-deny");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const base = `/api/groups/${groupId}/channels/${channelId}/messages`;

    const lateId = seedMessage(b, groupId, channelId, alice.actor, "late");
    b.db.drizzle
      .update(messages)
      .set({ editUntil: Date.now() - 1000 })
      .where(eq(messages.id, lateId))
      .run();
    const late = await signedReq(b, alice, "PATCH", `${base}/${lateId}`, {
      content: { mime: "text/plain", text: "x" },
    });
    expect(late.status).toBe(403);

    const otherId = seedMessage(b, groupId, channelId, alice.actor, "alice's");
    const byBob = await signedReq(b, bob, "PATCH", `${base}/${otherId}`, {
      content: { mime: "text/plain", text: "x" },
    });
    expect(byBob.status).toBe(403);

    const missing = await signedReq(b, alice, "PATCH", `${base}/msg_nope`, {
      content: { mime: "text/plain", text: "x" },
    });
    expect(missing.status).toBe(404);
  });

  test("DELETE tombstones (204), reaches a WS subscriber, and keeps it in history", async () => {
    const b = boot("rest-delete");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const messageId = seedMessage(b, groupId, channelId, alice.actor, "doomed");

    const watcher = await connectAuthenticated(b, alice);
    await subscribe(watcher, channelId);

    const res = await signedReq(
      b,
      alice,
      "DELETE",
      `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}`,
    );
    expect(res.status).toBe(204);

    const evt = await watcher.ofType("message.deleted");
    expect((evt.data as { messageId: string }).messageId).toBe(messageId);

    const r = row(b, messageId);
    expect(r?.deletedAt).not.toBeNull();
    expect(JSON.parse(r?.content ?? "{}").text).toBe("");

    const hist = await signedReq(
      b,
      alice,
      "GET",
      `/api/groups/${groupId}/channels/${channelId}/messages`,
    );
    const items = ((await hist.json()) as { items: { id: string }[] }).items;
    expect(items.some((m) => m.id === messageId)).toBe(true);
    watcher.close();
  });

  test("DELETE by non-author non-moderator → 403; by moderator → 204", async () => {
    const b = boot("rest-delete-authz");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const mod = await registerUserWithKey(b, "mod");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const base = `/api/groups/${groupId}/channels/${channelId}/messages`;

    const m1 = seedMessage(b, groupId, channelId, alice.actor);
    addMember(b, groupId, bob, "guest");
    const forbidden = await signedReq(b, bob, "DELETE", `${base}/${m1}`);
    expect(forbidden.status).toBe(403);
    expect(row(b, m1)?.deletedAt).toBeNull();

    const m2 = seedMessage(b, groupId, channelId, alice.actor);
    addMember(b, groupId, mod, "admin");
    const ok = await signedReq(b, mod, "DELETE", `${base}/${m2}`);
    expect(ok.status).toBe(204);
    expect(row(b, m2)?.deletedAt).not.toBeNull();
  });
});
