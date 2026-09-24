/**
 * Loss of access over a live WebSocket (reconciliation #15; pending OFSCP Spec
 * PR 2). §7.1 enforces authorization at subscribe-time; these tests pin down
 * what happens AFTER that when access is lost:
 *
 *  - kick / leave / role change / channel `view` or tier change / channel or
 *    group deletion → the connection stops receiving the channel and gets an
 *    unprompted `unsubscribed { channels, reason: "access_revoked" }` (no
 *    `correlationId`);
 *  - members who can still read the channel keep receiving (no over-revocation);
 *  - a path that bypasses the REST hooks is still caught at delivery time;
 *  - revoking the device key a socket authenticated with closes it with `4003`
 *    (other devices of the same user stay connected); so does a guest claim,
 *    which re-binds the key to a different actor.
 *
 * Real `Bun.serve` + `new WebSocket`, mirroring `ws.test.ts`.
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
import { addMember, removeMember } from "../src/provider/membership.ts";
import type { Hub } from "../src/provider/ws-hub.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";
const FAST_TIMINGS = {
  authTimeoutMs: 1000,
  challengeTtlMs: 10_000,
  pingIntervalMs: 200,
  idleTimeoutMs: 100_000,
};
/** How long to wait to be confident a frame is NOT coming. */
const QUIET_MS = 250;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-ws-revoke-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Booted {
  app: AppWithWebSocket;
  hub: Hub;
  db: ReturnType<typeof openDb>;
  server: ReturnType<typeof Bun.serve>;
  url: string;
}

const booted: Booted[] = [];
const clients: WsClient[] = [];

let bootCount = 0;
function boot(): Booted {
  bootCount += 1;
  const name = `revoke-${bootCount}`;
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
    hub: app.__hub,
    db,
    server,
    url: `ws://${server.hostname}:${server.port}/api/ws`,
  };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const b of booted.splice(0)) {
    b.server.stop(true);
    b.db.sqlite.close();
  }
});

// ---------------------------------------------------------------------------
// Identities + signed HTTP
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

/** Add a device key for `handle` with a fresh bootstrap token. */
async function addDeviceKey(b: Booted, handle: string, token: string): Promise<Signer> {
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

async function registerUser(b: Booted, handle: string): Promise<Signer> {
  const reg = await http(b, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;
  return addDeviceKey(b, handle, token);
}

/** A second device for an existing user (login → bootstrap token → key). */
async function addSecondDevice(b: Booted, signer: Signer): Promise<Signer> {
  const login = await http(b, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: signer.handle, password: "correct-horse" }),
  });
  expect(login.status).toBe(200);
  const token = ((await login.json()) as AuthBootstrapResponse).bootstrap_token;
  return addDeviceKey(b, signer.handle, token);
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

async function createGroup(b: Booted, owner: Signer): Promise<string> {
  const res = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: "private" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function createChannel(
  b: Booted,
  owner: Signer,
  groupId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
    type: "text",
    name: "general",
    tier: "group",
    ...extra,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

// ---------------------------------------------------------------------------
// WS client
// ---------------------------------------------------------------------------

class WsClient {
  readonly ws: WebSocket;
  readonly frames: WsEnvelope[] = [];
  private readonly listeners = new Set<() => void>();
  closeCode: number | undefined;
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      this.frames.push(JSON.parse(String(e.data)) as WsEnvelope);
      for (const l of [...this.listeners]) l();
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = true;
      this.closeCode = e.code;
      for (const l of [...this.listeners]) l();
    });
  }

  static async open(url: string): Promise<WsClient> {
    const c = new WsClient(url);
    clients.push(c);
    await new Promise<void>((resolve, reject) => {
      c.ws.addEventListener("open", () => resolve(), { once: true });
      c.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    return c;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait until `cond()` holds (re-evaluated on every frame/close). */
  private until<T>(cond: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    const now = cond();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`timeout waiting for ${what}`));
      }, timeoutMs);
      const check = () => {
        const v = cond();
        if (v === undefined) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(v);
      };
      this.listeners.add(check);
    });
  }

  /** Remove + return the first received frame matching `pred`, waiting for it. */
  take(pred: (f: WsEnvelope) => boolean, timeoutMs = 2000): Promise<WsEnvelope> {
    return this.until(
      () => {
        const i = this.frames.findIndex(pred);
        return i === -1 ? undefined : this.frames.splice(i, 1)[0];
      },
      timeoutMs,
      "frame",
    );
  }

  /** Whether any received frame matches `pred`, after waiting `ms`. */
  async sawWithin(pred: (f: WsEnvelope) => boolean, ms = QUIET_MS): Promise<boolean> {
    await Bun.sleep(ms);
    return this.frames.some(pred);
  }

  waitClosed(timeoutMs = 2000): Promise<number | undefined> {
    return this.until(() => (this.closed ? (this.closeCode ?? -1) : undefined), timeoutMs, "close");
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

async function connect(b: Booted, signer: Signer): Promise<WsClient> {
  const client = await WsClient.open(b.url);
  const challenge = await client.take((f) => f.type === "auth.challenge");
  const timestamp = rfc3339Timestamp();
  const { signature } = signWsAuthenticate({
    privateKey: signer.privateKey,
    authority: DOMAIN,
    challengeNonce: (challenge.data as { nonce: string }).nonce,
    timestamp,
  });
  client.send({
    id: "cli_auth",
    type: "authenticate",
    ts: rfc3339Timestamp(),
    data: { actor: signer.actor, keyId: signer.keyId, timestamp, signature },
  });
  await client.take((f) => f.type === "authenticated");
  return client;
}

async function subscribe(client: WsClient, channels: string[]): Promise<void> {
  client.send({ id: "cli_sub", type: "subscribe", ts: rfc3339Timestamp(), data: { channels } });
  const ack = await client.take((f) => f.type === "subscribed" && f.correlationId === "cli_sub");
  expect((ack.data as { channels: string[] }).channels).toEqual(channels);
}

let postSeq = 0;
/** Post `text` to a channel over `author`'s socket and wait for its own echo. */
async function post(
  author: WsClient,
  groupId: string,
  channelId: string,
  text: string,
): Promise<void> {
  postSeq += 1;
  const id = `cli_post_${postSeq}`;
  author.send({
    id,
    type: "message.create",
    ts: rfc3339Timestamp(),
    data: { groupId, channelId, content: { mime: "text/plain", text } },
  });
  await author.take((f) => f.type === "message.created" && f.correlationId === id);
}

const isCreated =
  (text: string) =>
  (f: WsEnvelope): boolean =>
    f.type === "message.created" &&
    (f.data as { message?: { content?: { text?: string } } }).message?.content?.text === text;

/** The unprompted revocation notice for `channels` (exact set). */
async function expectRevoked(client: WsClient, channels: string[]): Promise<void> {
  const notice = await client.take(
    (f) => f.type === "unsubscribed" && f.correlationId === undefined,
  );
  const data = notice.data as { channels: string[]; reason: string };
  expect(data.reason).toBe("access_revoked");
  expect([...data.channels].sort()).toEqual([...channels].sort());
}

const noticeFor = (f: WsEnvelope): boolean =>
  f.type === "unsubscribed" && f.correlationId === undefined;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loss of access ends live subscriptions (#15)", () => {
  test("a kicked member stops receiving and gets the revocation notice; others keep receiving", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const bob = await registerUser(b, "bob");
    const carol = await registerUser(b, "carol");
    const groupId = await createGroup(b, owner);
    const privateChannel = await createChannel(b, owner, groupId);
    const publicChannel = await createChannel(b, owner, groupId, { tier: "public" });
    addMember(b.db, groupId, bob.actor);
    addMember(b.db, groupId, carol.actor);

    const ownerWs = await connect(b, owner);
    const bobWs = await connect(b, bob);
    const carolWs = await connect(b, carol);
    await subscribe(ownerWs, [privateChannel, publicChannel]);
    await subscribe(bobWs, [privateChannel, publicChannel]);
    await subscribe(carolWs, [privateChannel]);

    const kick = await signedReq(
      b,
      owner,
      "DELETE",
      `/api/groups/${groupId}/members/${encodeURIComponent(bob.actor)}`,
    );
    expect(kick.status).toBe(204);

    // Only the private channel is revoked: a public channel stays readable.
    await expectRevoked(bobWs, [privateChannel]);
    expect(b.hub.subscriberCount(privateChannel)).toBe(2);

    await post(ownerWs, groupId, privateChannel, "after-kick");
    await post(ownerWs, groupId, publicChannel, "public-after-kick");
    await carolWs.take(isCreated("after-kick")); // no over-revocation
    await bobWs.take(isCreated("public-after-kick"));
    expect(await bobWs.sawWithin(isCreated("after-kick"))).toBe(false);
    expect(await carolWs.sawWithin(noticeFor, 0)).toBe(false);
    expect(ownerWs.frames.some(noticeFor)).toBe(false);
  });

  test("leaving a group ends the leaver's subscriptions", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const bob = await registerUser(b, "bob");
    const groupId = await createGroup(b, owner);
    const channelId = await createChannel(b, owner, groupId);
    addMember(b.db, groupId, bob.actor);

    const bobWs = await connect(b, bob);
    await subscribe(bobWs, [channelId]);
    const res = await signedReq(b, bob, "POST", `/api/groups/${groupId}/leave`);
    expect(res.status).toBe(204);
    await expectRevoked(bobWs, [channelId]);
    expect(b.hub.subscriberCount(channelId)).toBe(0);
  });

  test("a role change that loses `view` removes access live", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const bob = await registerUser(b, "bob");
    const groupId = await createGroup(b, owner);
    const staff = await createChannel(b, owner, groupId, { permissions: { view: ["admin"] } });
    const general = await createChannel(b, owner, groupId);
    addMember(b.db, groupId, bob.actor, "admin");

    const ownerWs = await connect(b, owner);
    const bobWs = await connect(b, bob);
    await subscribe(ownerWs, [staff]);
    await subscribe(bobWs, [staff, general]);

    const res = await signedReq(
      b,
      owner,
      "PATCH",
      `/api/groups/${groupId}/members/${encodeURIComponent(bob.actor)}`,
      { role: "member" },
    );
    expect(res.status).toBe(200);

    // Still a member → keeps `general`; loses only the admin-only channel.
    await expectRevoked(bobWs, [staff]);
    await post(ownerWs, groupId, staff, "staff-only");
    expect(await bobWs.sawWithin(isCreated("staff-only"))).toBe(false);
  });

  test("a channel `permissions.view` change removes access live (owner keeps it)", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const bob = await registerUser(b, "bob");
    const groupId = await createGroup(b, owner);
    const channelId = await createChannel(b, owner, groupId);
    addMember(b.db, groupId, bob.actor);

    const ownerWs = await connect(b, owner);
    const bobWs = await connect(b, bob);
    await subscribe(ownerWs, [channelId]);
    await subscribe(bobWs, [channelId]);

    const res = await signedReq(b, owner, "PATCH", `/api/groups/${groupId}/channels/${channelId}`, {
      permissions: { view: ["admin"] },
    });
    expect(res.status).toBe(200);

    await expectRevoked(bobWs, [channelId]);
    await post(ownerWs, groupId, channelId, "restricted");
    expect(await bobWs.sawWithin(isCreated("restricted"))).toBe(false);
    expect(ownerWs.frames.some(noticeFor)).toBe(false);
  });

  test("a channel tier change (public → group) revokes non-members only", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const member = await registerUser(b, "member");
    const outsider = await registerUser(b, "outsider");
    const groupId = await createGroup(b, owner);
    const channelId = await createChannel(b, owner, groupId, { tier: "public" });
    addMember(b.db, groupId, member.actor);

    const memberWs = await connect(b, member);
    const outsiderWs = await connect(b, outsider);
    await subscribe(memberWs, [channelId]);
    await subscribe(outsiderWs, [channelId]);

    const res = await signedReq(b, owner, "PATCH", `/api/groups/${groupId}/channels/${channelId}`, {
      tier: "group",
    });
    expect(res.status).toBe(200);

    await expectRevoked(outsiderWs, [channelId]);
    expect(await memberWs.sawWithin(noticeFor)).toBe(false);
    expect(b.hub.subscriberCount(channelId)).toBe(1);
  });

  test("deleting a channel ends every subscription to it", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const bob = await registerUser(b, "bob");
    const groupId = await createGroup(b, owner);
    const doomed = await createChannel(b, owner, groupId);
    const kept = await createChannel(b, owner, groupId);
    addMember(b.db, groupId, bob.actor);

    const ownerWs = await connect(b, owner);
    const bobWs = await connect(b, bob);
    await subscribe(ownerWs, [doomed, kept]);
    await subscribe(bobWs, [doomed]);

    const res = await signedReq(b, owner, "DELETE", `/api/groups/${groupId}/channels/${doomed}`);
    expect(res.status).toBe(204);

    await expectRevoked(ownerWs, [doomed]);
    await expectRevoked(bobWs, [doomed]);
    expect(b.hub.subscriberCount(doomed)).toBe(0);
    expect(b.hub.subscriberCount(kept)).toBe(1);
  });

  test("deleting a group ends the subscriptions to all its channels", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const bob = await registerUser(b, "bob");
    const groupId = await createGroup(b, owner);
    const c1 = await createChannel(b, owner, groupId);
    const c2 = await createChannel(b, owner, groupId, { tier: "public" });
    addMember(b.db, groupId, bob.actor);

    const bobWs = await connect(b, bob);
    await subscribe(bobWs, [c1, c2]);

    const res = await signedReq(b, owner, "DELETE", `/api/groups/${groupId}`);
    expect(res.status).toBe(204);
    await expectRevoked(bobWs, [c1, c2]);
  });

  test("defence in depth: a membership change that bypasses the hooks is caught at delivery", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const bob = await registerUser(b, "bob");
    const groupId = await createGroup(b, owner);
    const channelId = await createChannel(b, owner, groupId);
    addMember(b.db, groupId, bob.actor);

    const ownerWs = await connect(b, owner);
    const bobWs = await connect(b, bob);
    await subscribe(ownerWs, [channelId]);
    await subscribe(bobWs, [channelId]);

    // Straight to storage: no REST route, so no revalidation hook ran.
    removeMember(b.db, groupId, bob.actor);
    expect(b.hub.subscriberCount(channelId)).toBe(2);

    await post(ownerWs, groupId, channelId, "gated");
    await expectRevoked(bobWs, [channelId]);
    expect(bobWs.frames.some(isCreated("gated"))).toBe(false);
    expect(b.hub.subscriberCount(channelId)).toBe(1);
  });
});

describe("device-key revocation ends the session (close 4003)", () => {
  test("revoking the key closes its socket; the user's other device stays connected", async () => {
    const b = boot();
    const alice = await registerUser(b, "alice");
    const aliceTablet = await addSecondDevice(b, alice);
    const groupId = await createGroup(b, alice);
    const channelId = await createChannel(b, alice, groupId);

    const laptopWs = await connect(b, alice);
    const tabletWs = await connect(b, aliceTablet);
    await subscribe(laptopWs, [channelId]);
    await subscribe(tabletWs, [channelId]);

    // Revoke the laptop key from the tablet.
    const res = await signedReq(b, aliceTablet, "DELETE", `/api/auth/device-keys/${alice.keyId}`);
    expect(res.status).toBe(204);

    expect(await laptopWs.waitClosed()).toBe(4003);
    const err = laptopWs.frames.find((f) => f.type === "error");
    expect((err?.data as { status: number } | undefined)?.status).toBe(401);
    expect(tabletWs.closed).toBe(false);
    expect(b.hub.subscriberCount(channelId)).toBe(1);

    await post(tabletWs, groupId, channelId, "still-here");
  });

  test("a guest claim closes sockets authenticated as the old guest actor", async () => {
    const b = boot();
    const owner = await registerUser(b, "owner");
    const groupId = await createGroup(b, owner);
    const invite = await signedReq(b, owner, "POST", `/api/groups/${groupId}/invites`, {
      grantsGuest: true,
      role: "guest",
    });
    expect(invite.status).toBe(201);
    const { token } = (await invite.json()) as { token: string };
    const { publicKey, privateKey } = generateKeyPair();
    const res = await http(b, `/api/invites/${token}/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Guest",
        public_key: publicKey,
        algorithm: "Ed25519",
        device_name: "dev",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { actor: string; key_id: string };
    const guest: Signer = {
      keyId: body.key_id,
      privateKey,
      actor: body.actor,
      handle: body.actor.slice(0, body.actor.lastIndexOf("@")),
    };

    const ws = await connect(b, guest);
    const claim = await signedReq(b, guest, "POST", "/api/me/claim", {
      handle: "ada",
      password: "correct-horse-battery",
    });
    expect(claim.status).toBe(200);
    expect(await ws.waitClosed()).toBe(4003);
  });

  test("revoking one's own current key closes that socket too", async () => {
    const b = boot();
    const alice = await registerUser(b, "alice");
    const ws = await connect(b, alice);
    const res = await signedReq(b, alice, "DELETE", `/api/auth/device-keys/${alice.keyId}`);
    expect(res.status).toBe(204);
    expect(await ws.waitClosed()).toBe(4003);
    expect(b.hub.size).toBe(0);
  });
});
