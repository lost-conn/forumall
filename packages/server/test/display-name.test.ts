/**
 * Per-group display name tests (Overboard "Per-group display name").
 *
 * A group-scoped nickname (`Member.displayNameOverride`) that overrides a user's
 * GLOBAL `UserProfile.displayName` within that one group only. Covers:
 *  - self may set/clear their OWN nickname (no special permission);
 *  - a member holding `members.set-nickname` may set ANOTHER member's;
 *  - an unpermitted member → 403;
 *  - the subset/self-protect rule blocks renaming a higher-powered target;
 *  - the member list + the `member.updated` WS event carry the field.
 *
 * Runs over a real `Bun.serve` + `new WebSocket` so the WS fan-out is exercised
 * end-to-end. Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Member,
  MemberSchema,
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
import { groupMembers } from "../src/db/schema.ts";

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
  tmp = mkdtempSync(join(tmpdir(), "forumall-displayname-"));
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
  const url = `ws://${server.hostname}:${server.port}/api/ws`;
  const b: Booted = { app, db, config, server, url };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

// ---------------------------------------------------------------------------
// HTTP + signing helpers
// ---------------------------------------------------------------------------

interface Signer {
  keyId: string;
  privateKey: string;
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
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}`, handle };
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

async function createGroup(
  b: Booted,
  owner: Signer,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await signedReq(b, owner, "POST", "/api/groups", body);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

function seedMember(db: Db, groupId: string, user: string, role: string): void {
  db.drizzle
    .insert(groupMembers)
    .values({ groupId, user, role, displayNameOverride: null, joinedAt: Date.now() })
    .run();
}

function ref(actor: string): string {
  return encodeURIComponent(actor);
}

function nickPath(groupId: string, actor: string): string {
  return `/api/groups/${groupId}/members/${ref(actor)}/display-name`;
}

// ---------------------------------------------------------------------------
// Tiny WS client (subset of typing.test.ts)
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

async function subscribe(client: WsClient, channelId: string): Promise<void> {
  client.send({
    id: "sub",
    type: "subscribe",
    ts: rfc3339Timestamp(),
    data: { channels: [channelId] },
  });
  await client.ofType("subscribed");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PATCH .../members/{userRef}/display-name (per-group display name)", () => {
  test("self may set then clear their OWN nickname (no special permission)", async () => {
    const b = boot("dn-self");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const group = await createGroup(b, alice, { name: "G", tier: "public", joinPolicy: "open" });
    seedMember(b.db, group.id, bob.actor, "member");

    // Set
    const set = await signedReq(b, bob, "PATCH", nickPath(group.id, bob.actor), {
      displayNameOverride: "Bobby",
    });
    expect(set.status).toBe(200);
    const m = (await set.json()) as Member;
    expect(() => MemberSchema.parse(m)).not.toThrow();
    expect(m.displayNameOverride).toBe("Bobby");

    // Clear (null)
    const clear = await signedReq(b, bob, "PATCH", nickPath(group.id, bob.actor), {
      displayNameOverride: null,
    });
    expect(clear.status).toBe(200);
    expect((await clear.json()).displayNameOverride).toBeUndefined();
  });

  test("a member with members.set-nickname may rename a lower-powered member → 200", async () => {
    const b = boot("dn-mod");
    const alice = await registerUserWithKey(b, "alice");
    const mod = await registerUserWithKey(b, "moduser");
    const bob = await registerUserWithKey(b, "bob");
    const group = await createGroup(b, alice, {
      name: "G",
      tier: "public",
      // nickmod holds every power a plain member holds (`post`) plus
      // `members.set-nickname`, so the subset rule is satisfied against a member.
      permissions: {
        post: ["nickmod", "member"],
        moderate: ["admin"],
        manage: ["admin"],
        "members.set-nickname": ["nickmod", "admin"],
      },
      roles: [{ name: "admin" }, { name: "nickmod" }, { name: "member" }],
    });
    seedMember(b.db, group.id, mod.actor, "nickmod");
    seedMember(b.db, group.id, bob.actor, "member");

    const res = await signedReq(b, mod, "PATCH", nickPath(group.id, bob.actor), {
      displayNameOverride: "B-dawg",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).displayNameOverride).toBe("B-dawg");
  });

  test("an unpermitted member renaming another → 403", async () => {
    const b = boot("dn-403");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const group = await createGroup(b, alice, { name: "G", tier: "public" });
    seedMember(b.db, group.id, bob.actor, "member");
    seedMember(b.db, group.id, carol.actor, "member");

    const res = await signedReq(b, bob, "PATCH", nickPath(group.id, carol.actor), {
      displayNameOverride: "nope",
    });
    expect(res.status).toBe(403);
  });

  test("subset rule blocks renaming a higher-powered target → 403", async () => {
    const b = boot("dn-subset");
    const alice = await registerUserWithKey(b, "alice");
    const mod = await registerUserWithKey(b, "moduser");
    const admin = await registerUserWithKey(b, "adminuser");
    const group = await createGroup(b, alice, {
      name: "G",
      tier: "public",
      // `nickmod` may set nicknames but not moderate; `admin` holds moderate too,
      // so admin's powers are NOT a subset of nickmod's → subset rule blocks it.
      permissions: {
        post: ["nickmod", "admin", "member"],
        moderate: ["admin"],
        manage: ["admin"],
        "members.set-nickname": ["nickmod", "admin"],
      },
      roles: [{ name: "admin" }, { name: "nickmod" }, { name: "member" }],
    });
    seedMember(b.db, group.id, mod.actor, "nickmod");
    seedMember(b.db, group.id, admin.actor, "admin");

    const res = await signedReq(b, mod, "PATCH", nickPath(group.id, admin.actor), {
      displayNameOverride: "boss",
    });
    expect(res.status).toBe(403);
  });

  test("member list carries displayNameOverride; setting it fans out member.updated", async () => {
    const b = boot("dn-list-ws");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const group = await createGroup(b, alice, { name: "G", tier: "public" });
    seedMember(b.db, group.id, bob.actor, "member");

    // A channel + a subscribed connection that should receive the fan-out.
    const cRes = await signedReq(b, alice, "POST", `/api/groups/${group.id}/channels`, {
      type: "text",
      name: "general",
      tier: "public",
    });
    expect(cRes.status).toBe(201);
    const channelId = ((await cRes.json()) as { id: string }).id;

    const watcher = await connectAuthenticated(b, alice);
    await subscribe(watcher, channelId);

    // Bob sets his own nickname over HTTP.
    const set = await signedReq(b, bob, "PATCH", nickPath(group.id, bob.actor), {
      displayNameOverride: "Bobby",
    });
    expect(set.status).toBe(200);

    // The subscribed connection receives member.updated carrying the field.
    const evt = await watcher.ofType("member.updated");
    const data = evt.data as { groupId: string; member: Member };
    expect(data.groupId).toBe(group.id);
    expect(data.member.user).toBe(bob.actor);
    expect(data.member.displayNameOverride).toBe("Bobby");

    // The member listing also carries it.
    const list = await signedReq(b, alice, "GET", `/api/groups/${group.id}/members`);
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: Member[] }).items;
    const bobMember = items.find((m) => m.user === bob.actor);
    expect(bobMember?.displayNameOverride).toBe("Bobby");

    watcher.close();
  });
});
