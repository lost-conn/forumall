/**
 * Notification webhook registration + delivery tests (spec §10).
 *
 * The delivery path is driven end-to-end through the REAL WS `message.create`
 * fan-out: each `boot()` starts the app on an ephemeral port (so a real WebSocket
 * can post a message) AND a small in-process `Bun.serve` receiver that captures
 * incoming delivery requests. An injected `federationFetch` maps the logical
 * delivery domain (`receiver.test`) to the receiver's localhost port while
 * preserving the authority — exactly the two-provider harness shape — so the
 * provider-signed request still binds the real domain.
 *
 * Covered:
 *  - bob registers an endpoint (signed) subscribed to `message.created`; another
 *    group member posts → the receiver gets `{ event, resource, provider, signature }`.
 *  - the detached body `signature` verifies against this provider's published
 *    signing key over the recomputed canonical payload.
 *  - the delivery HTTP request carries provider-signed `X-OFSCP-*` headers
 *    (`X-OFSCP-Provider` present).
 *  - a tampered stored payload → signature verification fails.
 *  - an endpoint not subscribed to the event, or owned by a non-member, gets
 *    no delivery.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Channel,
  type Group,
  type WsEnvelope,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signWsAuthenticate,
  verifyDetached,
} from "@forumall/shared";

import { type AppWithWebSocket, createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { groupMembers } from "../src/db/schema.ts";
import type { FederationFetch } from "../src/provider/federation/http.ts";
import { canonicalDeliveryPayload } from "../src/provider/notifications.ts";
import { getProviderSigningKey } from "../src/provider/signing-key.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";
/** Logical domain the webhook `target` URLs use; mapped to the receiver port. */
const RECEIVER_DOMAIN = "receiver.test";

const FAST_TIMINGS = {
  authTimeoutMs: 1000,
  challengeTtlMs: 10_000,
  pingIntervalMs: 5_000,
  idleTimeoutMs: 100_000,
};

const tmp = mkdtempSync(join(tmpdir(), "forumall-notif-"));

/** One captured inbound delivery request (headers + parsed JSON body). */
interface Captured {
  headers: Record<string, string>;
  body: unknown;
}

interface Booted {
  app: AppWithWebSocket;
  db: ReturnType<typeof openDb>;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
  receiver: ReturnType<typeof Bun.serve>;
  captured: Captured[];
  /** Resolves with the next captured delivery (or rejects on timeout). */
  nextDelivery(timeoutMs?: number): Promise<Captured>;
  url: string;
  httpBase: string;
}

const booted: Booted[] = [];

function boot(name: string): Booted {
  const captured: Captured[] = [];
  const deliveryWaiters: ((c: Captured) => void)[] = [];

  // In-process receiver: capture every POST, ack 200.
  const receiver = Bun.serve({
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const body = await req.json().catch(() => null);
      const c: Captured = { headers, body };
      captured.push(c);
      const w = deliveryWaiters.shift();
      if (w) w(c);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  // Map the logical RECEIVER_DOMAIN to the receiver's localhost port while
  // preserving the Host/authority (so the provider-signed request keeps the real
  // domain as its authority). Other domains hit the global fetch.
  const federationFetch: FederationFetch = (domain, request) => {
    if (domain === RECEIVER_DOMAIN) {
      const orig = new URL(request.url);
      const rewritten = new URL(orig.pathname + orig.search, `http://localhost:${receiver.port}`);
      return fetch(new Request(rewritten, request));
    }
    return fetch(request);
  };

  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db, wsTimings: FAST_TIMINGS, federationFetch });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });

  const b: Booted = {
    app,
    db,
    config,
    server,
    receiver,
    captured,
    nextDelivery(timeoutMs = 2000) {
      const queued = captured.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<Captured>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for delivery")),
          timeoutMs,
        );
        deliveryWaiters.push((c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
    },
    url: `ws://${server.hostname}:${server.port}/api/ws`,
    httpBase: `http://${server.hostname}:${server.port}`,
  };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const b of booted.splice(0)) {
    b.server.stop(true);
    b.receiver.stop(true);
  }
});

// ---------------------------------------------------------------------------
// HTTP + signing helpers.
// ---------------------------------------------------------------------------

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
  handle: string;
}

async function http(b: Booted, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${b.httpBase}${path}`, init);
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

function signed(b: Booted, signer: Signer, method: string, path: string, bodyObj?: unknown) {
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

function addMember(b: Booted, groupId: string, actor: string, role: string): void {
  b.db.drizzle
    .insert(groupMembers)
    .values({ groupId, user: actor, role, joinedAt: Date.now() })
    .run();
}

// ---------------------------------------------------------------------------
// Minimal WS client (subset of the ws.test.ts helper).
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
    const idx = this.queue.findIndex(pred);
    if (idx !== -1) return Promise.resolve(this.queue.splice(idx, 1)[0] as WsEnvelope);
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

/** Subscribe a connection to a channel and await the ack (so the author copy lands). */
async function subscribe(client: WsClient, channelId: string): Promise<void> {
  client.send({
    id: "cli_sub_1",
    type: "subscribe",
    ts: rfc3339Timestamp(),
    data: { channels: [channelId] },
  });
  await client.ofType("subscribed");
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
    id: "cli_auth_1",
    type: "authenticate",
    ts: rfc3339Timestamp(),
    data: { actor: signer.actor, keyId: signer.keyId, timestamp, signature },
  });
  await client.ofType("authenticated");
  return client;
}

// ---------------------------------------------------------------------------
// Test scaffolding: a group with alice (owner) + bob (member) and a channel.
// ---------------------------------------------------------------------------

async function setupGroupChannel(b: Booted) {
  const alice = await registerUserWithKey(b, "alice");
  const bob = await registerUserWithKey(b, "bob");

  const gRes = await signed(b, alice, "POST", "/api/groups", {
    name: "G",
    tier: "group",
    permissions: { post: ["member"] },
  });
  expect(gRes.status).toBe(201);
  const group = (await gRes.json()) as Group;

  const cRes = await signed(b, alice, "POST", `/api/groups/${group.id}/channels`, {
    type: "text",
    tier: "group",
    name: "general",
  });
  expect(cRes.status).toBe(201);
  const channel = (await cRes.json()) as Channel;

  // bob is a member of the group (alice is owner from create).
  addMember(b, group.id, bob.actor, "member");
  return { alice, bob, group, channel };
}

async function registerEndpoint(
  b: Booted,
  signer: Signer,
  events: string[],
  path = "/hook",
): Promise<{ id: string }> {
  const res = await signed(b, signer, "POST", "/api/notifications/endpoints", {
    type: "webpush",
    target: `https://${RECEIVER_DOMAIN}${path}`,
    events,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notification webhooks (§10)", () => {
  test("member endpoint subscribed to message.created receives a signed delivery", async () => {
    const b = boot("notif-deliver");
    const { alice, bob, group, channel } = await setupGroupChannel(b);

    await registerEndpoint(b, bob, ["message.created"]);

    // alice (a different member) posts a message over WS → fan-out + notify.
    const aliceWs = await connectAuthenticated(b, alice);
    await subscribe(aliceWs, channel.id);
    aliceWs.send({
      id: "cli_post_1",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId: group.id,
        channelId: channel.id,
        content: { text: "hi", mime: "text/plain" },
      },
    });
    const created = await aliceWs.ofType("message.created");
    const msgId = (created.data as { message: { id: string } }).message.id;

    const delivery = await b.nextDelivery();
    const body = delivery.body as {
      event: string;
      resource: { id: string; channel?: string };
      provider: string;
      signature: string;
    };

    // Body shape (§10).
    expect(body.event).toBe("message.created");
    expect(body.resource.id).toBe(msgId);
    expect(body.resource.channel).toBe(channel.id);
    expect(body.provider).toBe(DOMAIN);
    expect(typeof body.signature).toBe("string");

    // The HTTP request was provider-signed (§8.1): X-OFSCP-Provider present.
    expect(delivery.headers["x-ofscp-provider"]).toBe(DOMAIN);
    expect(delivery.headers["x-ofscp-signature"]).toBeDefined();
    expect(delivery.headers["x-ofscp-key-id"]).toBeDefined();

    // The detached signature verifies against this provider's published signing
    // key over the RECOMPUTED canonical payload.
    const pub = getProviderSigningKey(b.db).publicKey;
    const canonical = canonicalDeliveryPayload({
      event: body.event,
      resource: body.resource,
      provider: body.provider,
    });
    expect(verifyDetached(pub, canonical, body.signature)).toBe(true);

    aliceWs.close();
  });

  test("a tampered stored payload fails detached signature verification", async () => {
    const b = boot("notif-tamper");
    const { alice, bob, group, channel } = await setupGroupChannel(b);
    await registerEndpoint(b, bob, ["message.created"]);

    const aliceWs = await connectAuthenticated(b, alice);
    await subscribe(aliceWs, channel.id);
    aliceWs.send({
      id: "cli_post_1",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId: group.id,
        channelId: channel.id,
        content: { text: "hi", mime: "text/plain" },
      },
    });
    await aliceWs.ofType("message.created");

    const delivery = await b.nextDelivery();
    const body = delivery.body as {
      event: string;
      resource: { id: string; channel?: string };
      provider: string;
      signature: string;
    };
    const pub = getProviderSigningKey(b.db).publicKey;

    // Flip a field (the resource id) and recompute the canonical payload → the
    // original signature must no longer verify.
    const tampered = canonicalDeliveryPayload({
      event: body.event,
      resource: { ...body.resource, id: `${body.resource.id}_TAMPERED` },
      provider: body.provider,
    });
    expect(verifyDetached(pub, tampered, body.signature)).toBe(false);

    aliceWs.close();
  });

  test("non-subscribed and non-member endpoints receive no delivery", async () => {
    const b = boot("notif-scope");
    const { alice, bob, group, channel } = await setupGroupChannel(b);

    // carol is registered but NOT a member of the group.
    const carol = await registerUserWithKey(b, "carol");

    // bob is a member but subscribes to a DIFFERENT event (call.started only).
    await registerEndpoint(b, bob, ["call.started"], "/bob-hook");
    // carol subscribes to message.created but is not a group member.
    await registerEndpoint(b, carol, ["message.created"], "/carol-hook");

    const aliceWs = await connectAuthenticated(b, alice);
    await subscribe(aliceWs, channel.id);
    aliceWs.send({
      id: "cli_post_1",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId: group.id,
        channelId: channel.id,
        content: { text: "hi", mime: "text/plain" },
      },
    });
    await aliceWs.ofType("message.created");

    // Give any (erroneous) delivery a chance to land, then assert none did.
    await new Promise((r) => setTimeout(r, 300));
    expect(b.captured.length).toBe(0);

    aliceWs.close();
  });

  test("endpoint registration is rejected unsigned and echoes an id when signed", async () => {
    const b = boot("notif-register");
    const bob = await registerUserWithKey(b, "bob");

    // Unsigned → 401.
    const unsigned = await http(b, "/api/notifications/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "webpush",
        target: "https://x.test/h",
        events: ["message.created"],
      }),
    });
    expect(unsigned.status).toBe(401);

    // Signed → 201 with an id + echoed fields.
    const res = await signed(b, bob, "POST", "/api/notifications/endpoints", {
      type: "webpush",
      target: "https://x.test/h",
      events: ["message.created", "call.started"],
    });
    expect(res.status).toBe(201);
    const ep = (await res.json()) as { id: string; type: string; events: string[] };
    expect(ep.id.startsWith("nep_")).toBe(true);
    expect(ep.type).toBe("webpush");
    expect(ep.events).toEqual(["message.created", "call.started"]);
  });
});
