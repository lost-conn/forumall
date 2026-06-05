/**
 * P6 real-time presence tests (spec §6.4 presence REST, §7.5 real-time presence).
 *
 * Exercises the WS surface (`presence.subscribe`/`unsubscribe`/`set`,
 * connection-derived online/offline) and the REST surface
 * (`GET /api/users/{ref}/presence`, `PUT /api/me/presence`) over a real
 * `Bun.serve` + `new WebSocket`, asserting the two surfaces agree per viewer and
 * that privacy filtering yields a uniform `offline` for unauthorized viewers.
 *
 * Short WS timings + reduced Argon2id cost (TEST-ONLY) keep the suite fast;
 * sockets are closed and the server stopped on teardown so no timer keeps the
 * loop alive.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Presence,
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

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

const FAST_TIMINGS = {
  authTimeoutMs: 300,
  challengeTtlMs: 10_000,
  // Keep the heartbeat ping out of the way of presence assertions.
  pingIntervalMs: 100_000,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-presence-"));
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
// HTTP + signing helpers.
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

async function getPresence(b: Booted, viewer: Signer, subject: Signer): Promise<Presence> {
  const res = await signedReq(b, viewer, "GET", `/api/users/${subject.handle}/presence`);
  expect(res.status).toBe(200);
  return (await res.json()) as Presence;
}

/** Make `owner` a group and add `member` (if given) to it. Returns the group id. */
async function makeGroup(b: Booted, owner: Signer, member?: Signer): Promise<string> {
  const gRes = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: "private" });
  expect(gRes.status).toBe(201);
  const groupId = ((await gRes.json()) as { id: string }).id;
  if (member) {
    // The owner mints an open invite and the member redeems it (no approval).
    const inv = await signedReq(b, owner, "POST", `/api/groups/${groupId}/invites`, {});
    expect(inv.status).toBe(201);
    const token = ((await inv.json()) as { token: string }).token;
    const red = await signedReq(b, member, "POST", `/api/invites/${token}/redeem`, {});
    expect(red.status).toBe(200);
  }
  return groupId;
}

/** Establish an accepted (mutual) contact between two LOCAL users. */
async function makeContacts(b: Booted, a: Signer, bb: Signer): Promise<void> {
  // `a` sends the request (creates a's outgoing + bb's incoming mirror).
  const req = await signedReq(b, a, "POST", "/api/me/contacts", { user: bb.actor });
  expect(req.status).toBe(201);
  // `bb` accepts their incoming pending request → both rows become accepted.
  const acc = await signedReq(b, bb, "POST", `/api/me/contacts/${a.actor}/accept`);
  expect(acc.status).toBe(200);
}

async function setVisibility(
  b: Booted,
  subject: Signer,
  presenceVisibility: string,
): Promise<void> {
  const res = await signedReq(b, subject, "PUT", "/api/me/privacy", { presenceVisibility });
  expect(res.status).toBe(200);
}

// ---------------------------------------------------------------------------
// Tiny WS client (subset of typing.test.ts).
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

interface PresenceData {
  user: string;
  presence: Presence;
}

/** Subscribe `client` to `subjects`' presence and collect the initial snapshots. */
async function presenceSubscribe(
  client: WsClient,
  subjects: string[],
): Promise<Map<string, Presence>> {
  client.send({
    id: "psub",
    type: "presence.subscribe",
    ts: rfc3339Timestamp(),
    data: { users: subjects },
  });
  await client.ofType("presence.subscribed");
  const snapshots = new Map<string, Presence>();
  for (let i = 0; i < subjects.length; i++) {
    const upd = await client.ofType("presence.update");
    const d = upd.data as PresenceData;
    snapshots.set(d.user, d.presence);
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Tests (§6.4 / §7.5)
// ---------------------------------------------------------------------------

describe("WS presence subscribe + snapshot + live updates (§7.5)", () => {
  test("bob subscribes to alice → snapshot, then alice connect/set dnd push updates", async () => {
    const b = boot("pr-sub");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    // Share a group so alice's default sharedGroups presence is visible to bob.
    await makeGroup(b, alice, bob);

    const bConn = await connectAuthenticated(b, bob);
    // Alice is not connected yet → snapshot is offline.
    const snap = await presenceSubscribe(bConn, [alice.actor]);
    expect(snap.get(alice.actor)?.availability).toBe("offline");

    // Alice connects → bob gets an online presence.update.
    const aConn = await connectAuthenticated(b, alice);
    const online = await bConn.ofType("presence.update");
    expect((online.data as PresenceData).user).toBe(alice.actor);
    expect((online.data as PresenceData).presence.availability).toBe("online");

    // Alice sets dnd + status → bob gets a dnd presence.update.
    aConn.send({
      id: "pset",
      type: "presence.set",
      ts: rfc3339Timestamp(),
      data: { availability: "dnd", status: "In a meeting" },
    });
    const dnd = await bConn.next(
      (f) =>
        f.type === "presence.update" && (f.data as PresenceData).presence.availability === "dnd",
    );
    expect((dnd.data as PresenceData).presence.status).toBe("In a meeting");

    aConn.close();
    bConn.close();
  });
});

describe("connection-derived online/offline (§7.5)", () => {
  test("connecting flips online; last close flips offline + sets lastSeen", async () => {
    const b = boot("pr-conn");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await makeGroup(b, alice, bob);

    const bConn = await connectAuthenticated(b, bob);
    await presenceSubscribe(bConn, [alice.actor]);

    const aConn = await connectAuthenticated(b, alice);
    const online = await bConn.ofType("presence.update");
    expect((online.data as PresenceData).presence.availability).toBe("online");

    aConn.close();
    const offline = await bConn.next(
      (f) =>
        f.type === "presence.update" &&
        (f.data as PresenceData).presence.availability === "offline",
    );
    const offData = offline.data as PresenceData;
    expect(offData.presence.availability).toBe("offline");
    // lastSeen is filtered OUT in the uniform-offline case, but bob is authorized
    // (shares a group), so the genuine offline carries lastSeen.
    expect(offData.presence.lastSeen).toBeDefined();

    bConn.close();
  });

  test("with two alice connections, closing one does NOT flip offline", async () => {
    const b = boot("pr-two");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await makeGroup(b, alice, bob);

    const bConn = await connectAuthenticated(b, bob);
    await presenceSubscribe(bConn, [alice.actor]);

    const a1 = await connectAuthenticated(b, alice);
    // First connection → online fan-out.
    await bConn.next(
      (f) =>
        f.type === "presence.update" && (f.data as PresenceData).presence.availability === "online",
    );

    // Second connection does NOT re-fan (already online).
    const a2 = await connectAuthenticated(b, alice);

    // Close one — alice still has a live connection, so NO offline update.
    a1.close();
    const noOffline = await bConn.none(
      (f) =>
        f.type === "presence.update" &&
        (f.data as PresenceData).presence.availability === "offline",
      400,
    );
    expect(noOffline).toBe(true);

    // Closing the LAST one flips offline.
    a2.close();
    const offline = await bConn.next(
      (f) =>
        f.type === "presence.update" &&
        (f.data as PresenceData).presence.availability === "offline",
    );
    expect((offline.data as PresenceData).presence.availability).toBe("offline");

    bConn.close();
  });
});

describe("presence.set persistence + offline rejection (§7.5)", () => {
  test("dnd persists across reconnect; not forced back to online", async () => {
    const b = boot("pr-persist");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await makeGroup(b, alice, bob);

    const a1 = await connectAuthenticated(b, alice);
    a1.send({
      id: "pset",
      type: "presence.set",
      ts: rfc3339Timestamp(),
      data: { availability: "dnd", status: "heads down" },
    });
    // Give the set time to persist before reconnecting.
    await Bun.sleep(50);
    a1.close();
    await Bun.sleep(50);

    // Reconnect: a fresh subscriber must see dnd (preserved), not online.
    const bConn = await connectAuthenticated(b, bob);
    const a2 = await connectAuthenticated(b, alice);
    const snap = await presenceSubscribe(bConn, [alice.actor]);
    expect(snap.get(alice.actor)?.availability).toBe("dnd");
    expect(snap.get(alice.actor)?.status).toBe("heads down");

    a2.close();
    bConn.close();
  });

  test("presence.set { availability: offline } is rejected (error)", async () => {
    const b = boot("pr-reject");
    const alice = await registerUserWithKey(b, "alice");
    const aConn = await connectAuthenticated(b, alice);
    aConn.send({
      id: "pbad",
      type: "presence.set",
      ts: rfc3339Timestamp(),
      data: { availability: "offline" },
    });
    const err = await aConn.ofType("error");
    expect((err.data as { status: number }).status).toBe(400);
    expect(err.correlationId).toBe("pbad");
    aConn.close();
  });

  test("PUT /api/me/presence { offline } → 400", async () => {
    const b = boot("pr-rest-reject");
    const alice = await registerUserWithKey(b, "alice");
    const res = await signedReq(b, alice, "PUT", "/api/me/presence", {
      availability: "offline",
      metadata: [],
    });
    expect(res.status).toBe(400);
  });
});

describe("privacy-filtered presence: WS snapshot + REST agree per viewer (§7.5)", () => {
  test("sharedGroups: non-sharer sees uniform offline on BOTH surfaces; sharer sees real", async () => {
    const b = boot("pr-filter");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob"); // shares a group with alice
    const carol = await registerUserWithKey(b, "carol"); // shares nothing

    await makeGroup(b, alice, bob);
    await setVisibility(b, alice, "sharedGroups");

    // Alice connects and sets dnd so a "real" state is distinguishable.
    const aConn = await connectAuthenticated(b, alice);
    aConn.send({
      id: "pset",
      type: "presence.set",
      ts: rfc3339Timestamp(),
      data: { availability: "dnd", status: "secret" },
    });
    await Bun.sleep(50);

    // --- carol (not sharing a group) → uniform offline on WS + REST ---
    const cConn = await connectAuthenticated(b, carol);
    const cSnap = await presenceSubscribe(cConn, [alice.actor]);
    const cWs = cSnap.get(alice.actor) as Presence;
    expect(cWs.availability).toBe("offline");
    expect(cWs.status).toBeUndefined();
    expect(cWs.lastSeen).toBeUndefined();

    const cRest = await getPresence(b, carol, alice);
    expect(cRest.availability).toBe("offline");
    expect(cRest.status).toBeUndefined();
    expect(cRest.lastSeen).toBeUndefined();
    // The two surfaces agree for carol.
    expect(cRest.availability).toBe(cWs.availability);

    // --- bob (shares a group) → real dnd on WS + REST ---
    const bConn = await connectAuthenticated(b, bob);
    const bSnap = await presenceSubscribe(bConn, [alice.actor]);
    const bWs = bSnap.get(alice.actor) as Presence;
    expect(bWs.availability).toBe("dnd");
    expect(bWs.status).toBe("secret");

    const bRest = await getPresence(b, bob, alice);
    expect(bRest.availability).toBe("dnd");
    expect(bRest.status).toBe("secret");
    expect(bRest.availability).toBe(bWs.availability);

    aConn.close();
    bConn.close();
    cConn.close();
  });

  test("contacts visibility: an accepted contact sees real presence", async () => {
    const b = boot("pr-contacts");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await makeContacts(b, alice, bob);
    await setVisibility(b, alice, "contacts");

    const aConn = await connectAuthenticated(b, alice);
    await Bun.sleep(30);

    // bob is an accepted contact → sees real (online) presence on REST.
    const bRest = await getPresence(b, bob, alice);
    expect(bRest.availability).toBe("online");

    // A non-contact (carol) sees uniform offline.
    const carol = await registerUserWithKey(b, "carol");
    const cRest = await getPresence(b, carol, alice);
    expect(cRest.availability).toBe("offline");

    aConn.close();
  });

  test("GET /presence and the WS snapshot are consistent for the same viewer", async () => {
    const b = boot("pr-consistent");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await makeGroup(b, alice, bob);

    // Alice online + away.
    const aConn = await connectAuthenticated(b, alice);
    aConn.send({
      id: "pset",
      type: "presence.set",
      ts: rfc3339Timestamp(),
      data: { availability: "away", status: "brb" },
    });
    await Bun.sleep(50);

    const bConn = await connectAuthenticated(b, bob);
    const snap = await presenceSubscribe(bConn, [alice.actor]);
    const ws = snap.get(alice.actor) as Presence;
    const rest = await getPresence(b, bob, alice);
    expect(rest.availability).toBe(ws.availability);
    expect(rest.status).toBe(ws.status);

    aConn.close();
    bConn.close();
  });
});
