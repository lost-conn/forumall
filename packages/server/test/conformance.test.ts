/**
 * P9 conformance suite — live response schema validation (§12).
 *
 * Boots a real provider (over `Bun.serve`, so the WebSocket path works) and
 * exercises representative REST + WS surfaces, validating each REAL response body
 * against the authoritative OFSCP v0.1 JSON Schemas in the sibling `ofscp` repo
 * using ajv (2020-12). This is strictly stronger than the zod mirror in
 * `@forumall/shared`: it proves the wire bytes satisfy the spec's own contract.
 *
 * Each `expectValid(schemaFile, body)` records the (schema, sample) pair so the
 * final "coverage" test can assert how many endpoints were validated and print a
 * summary a reviewer can scan.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { type SchemaValidator, makeOfscpCompiler } from "./helpers/ofscp-schemas.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

const FAST_TIMINGS = {
  authTimeoutMs: 500,
  challengeTtlMs: 10_000,
  pingIntervalMs: 5_000,
  idleTimeoutMs: 100_000,
};

// ---------------------------------------------------------------------------
// Ajv: compile every schema we'll need up front (cached validators).
// ---------------------------------------------------------------------------

const compile = makeOfscpCompiler();
const validators = new Map<string, SchemaValidator>();

/** Records every (schemaFile) that was validated against a live response. */
const validated = new Set<string>();

async function getValidator(schemaFile: string): Promise<SchemaValidator> {
  let v = validators.get(schemaFile);
  if (!v) {
    v = await compile(schemaFile);
    validators.set(schemaFile, v);
  }
  return v;
}

/**
 * Assert `body` validates against `ofscp/schemas/v0.1/{schemaFile}`. On failure,
 * throw with ajv's errors so the precise spec violation surfaces.
 */
async function expectValid(schemaFile: string, body: unknown): Promise<void> {
  const validate = await getValidator(schemaFile);
  const ok = validate(body);
  if (!ok) {
    throw new Error(
      `Response did NOT validate against ${schemaFile}:\n` +
        `${JSON.stringify(validate.errors, null, 2)}\n` +
        `body:\n${JSON.stringify(body, null, 2)}`,
    );
  }
  validated.add(schemaFile);
  expect(ok).toBe(true);
}

// ---------------------------------------------------------------------------
// Boot a single real server for the whole suite.
// ---------------------------------------------------------------------------

interface Booted {
  app: AppWithWebSocket;
  db: ReturnType<typeof openDb>;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
  origin: string;
  wsUrl: string;
}

let tmp: string;
let b: Booted;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-conformance-"));
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, "conf.sqlite"),
    WEB_DIR: join(tmp, "conf-web"),
    DOMAIN,
    // Light up the OPTIONAL discovery surfaces so we can validate them too.
    ENABLE_KNOWN_PROVIDERS: "true",
    ENABLE_DISCOVER_FEED: "true",
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db, wsTimings: FAST_TIMINGS });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  b = {
    app,
    db,
    config,
    server,
    origin: `http://${server.hostname}:${server.port}`,
    wsUrl: `ws://${server.hostname}:${server.port}/api/ws`,
  };
});

afterAll(() => {
  b.server.stop(true);
  b.db.sqlite.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Identity + signing helpers (over the real server).
// ---------------------------------------------------------------------------

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
  handle: string;
}

function http(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${b.origin}${path}`, init);
}

async function registerUserWithKey(handle: string): Promise<Signer> {
  const reg = await http("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const res = await http("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}`, handle };
}

/** Issue a signed request over the real server (optional JSON body). */
function signedReq(
  signer: Signer,
  method: string,
  path: string,
  bodyObj?: unknown,
): Promise<Response> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  // The canonical string signs path and query as SEPARATE lines, so a query
  // string must be passed via `query`, not folded into `path`.
  const qIdx = path.indexOf("?");
  const signPath = qIdx === -1 ? path : path.slice(0, qIdx);
  const query = qIdx === -1 ? undefined : path.slice(qIdx + 1);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    path: signPath,
    ...(query !== undefined ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  return http(path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tiny WS client (subset of ws.test.ts) for the realtime envelope checks.
// ---------------------------------------------------------------------------

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: WsEnvelope[] = [];
  private readonly waiters: {
    pred: (f: WsEnvelope) => boolean;
    resolve: (f: WsEnvelope) => void;
  }[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as WsEnvelope;
      const idx = this.waiters.findIndex((w) => w.pred(frame));
      if (idx !== -1) {
        const [w] = this.waiters.splice(idx, 1);
        w?.resolve(frame);
      } else {
        this.queue.push(frame);
      }
    });
  }

  static open(url: string): Promise<WsClient> {
    const c = new WsClient(url);
    return new Promise((resolve, reject) => {
      c.ws.addEventListener("open", () => resolve(c), { once: true });
      c.ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  next(pred: (f: WsEnvelope) => boolean, timeoutMs = 3000): Promise<WsEnvelope> {
    const hit = this.queue.findIndex(pred);
    if (hit !== -1) {
      const [f] = this.queue.splice(hit, 1);
      return Promise.resolve(f as WsEnvelope);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  ofType(type: string, timeoutMs = 3000): Promise<WsEnvelope> {
    return this.next((f) => f.type === type, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

async function connectAuthenticated(signer: Signer): Promise<WsClient> {
  const client = await WsClient.open(b.wsUrl);
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

// ---------------------------------------------------------------------------
// 1. Discovery + identity surfaces (unauthenticated).
// ---------------------------------------------------------------------------

describe("live schema validation: discovery + identity (§3.1, §4.6, §11.1)", () => {
  test("GET /.well-known/ofscp-provider → provider-discovery.json", async () => {
    const res = await http("/.well-known/ofscp-provider");
    expect(res.status).toBe(200);
    await expectValid("provider-discovery.json", await res.json());
  });

  test("GET /api/tiers → tiers-response.json", async () => {
    const res = await http("/api/tiers");
    expect(res.status).toBe(200);
    await expectValid("tiers-response.json", await res.json());
  });

  test("GET /.well-known/ofscp/users/{handle}/keys → user-keys-response.json", async () => {
    await registerUserWithKey("keyholder");
    const res = await http("/.well-known/ofscp/users/keyholder/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys.length).toBeGreaterThan(0); // the device key we just registered
    await expectValid("user-keys-response.json", body);
  });

  test("GET /api/providers → providers-response.json (OPTIONAL §8.6)", async () => {
    const res = await http("/api/providers");
    expect(res.status).toBe(200);
    await expectValid("providers-response.json", await res.json());
  });

  test("GET /api/discover → discover-response.json (OPTIONAL §11.2)", async () => {
    const res = await http("/api/discover");
    expect(res.status).toBe(200);
    await expectValid("discover-response.json", await res.json());
  });
});

// ---------------------------------------------------------------------------
// 2. Error path → ProblemDetails.
// ---------------------------------------------------------------------------

describe("live schema validation: error path (§2.5)", () => {
  test("unsigned POST /api/groups → 401 problem-details.json", async () => {
    const res = await http("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    await expectValid("problem-details.json", await res.json());
  });
});

// ---------------------------------------------------------------------------
// 3. Groups / channels / membership / invites / messages / reactions.
// ---------------------------------------------------------------------------

describe("live schema validation: groups, channels, messaging (§5, §7)", () => {
  test("end-to-end create + read flow validates every object", async () => {
    const alice = await registerUserWithKey("alice");
    const bob = await registerUserWithKey("bob");

    // Group (§5.5). Open join policy so bob can join directly below and yield a
    // canonical Member object.
    const gRes = await signedReq(alice, "POST", "/api/groups", {
      name: "Dev Guild",
      tier: "public",
      joinPolicy: "open",
    });
    expect(gRes.status).toBe(201);
    const group = (await gRes.json()) as { id: string };
    await expectValid("group.json", group);

    // Channel (§5.5)
    const cRes = await signedReq(alice, "POST", `/api/groups/${group.id}/channels`, {
      type: "text",
      name: "general",
      tier: "public",
    });
    expect(cRes.status).toBe(201);
    const channel = (await cRes.json()) as { id: string };
    await expectValid("channel.json", channel);

    // Channel carrying per-channel permissions (§5.2.1) — validates the
    // `ChannelPermissions` shape on a live Channel object.
    const cpRes = await signedReq(alice, "POST", `/api/groups/${group.id}/channels`, {
      type: "text",
      name: "announcements",
      tier: "group",
      permissions: {
        view: ["member"],
        "post:memo": ["admin"],
        "post:article": ["admin"],
        replyOnly: ["member"],
        replyOnlyTo: ["memo", "article"],
      },
    });
    expect(cpRes.status).toBe(201);
    await expectValid("channel.json", await cpRes.json());

    // Invite (§5.6)
    const invRes = await signedReq(alice, "POST", `/api/groups/${group.id}/invites`, {});
    expect(invRes.status).toBe(201);
    const invite = (await invRes.json()) as { token: string };
    await expectValid("invite.json", invite);

    // Member (§5.7): bob joins the open group → canonical Member object.
    // NOTE: `POST /invites/{token}/redeem` returns `{ groupId, channelId?, role }`
    // by design (a join receipt), NOT a Member; the Member object is produced by
    // the join endpoint and the members listing.
    const join = await signedReq(bob, "POST", `/api/groups/${group.id}/join`);
    expect(join.status).toBe(201);
    await expectValid("member.json", await join.json());

    // Member list page
    const membersRes = await signedReq(alice, "GET", `/api/groups/${group.id}/members`);
    expect(membersRes.status).toBe(200);
    const members = (await membersRes.json()) as { items: unknown[] };
    for (const m of members.items) await expectValid("member.json", m);

    // Message: post one via WS so we can validate the realtime envelope too,
    // then read it back through history (messages-page + message).
    const aConn = await connectAuthenticated(alice);
    aConn.send({
      id: "cli_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channel.id] },
    });
    await aConn.ofType("subscribed");
    aConn.send({
      id: "cli_post_1",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: {
        groupId: group.id,
        channelId: channel.id,
        clientMessageId: "cmsg_1",
        content: { mime: "text/plain", text: "hi from conformance" },
      },
    });

    // WS `message.created` envelope (§7.1)
    const created = await aConn.ofType("message.created");
    await expectValid("ws/message-created.json", created);
    aConn.close();

    // Message history (§7.2): messages-page + each Message
    const histRes = await signedReq(
      alice,
      "GET",
      `/api/groups/${group.id}/channels/${channel.id}/messages?direction=backward&limit=20`,
    );
    expect(histRes.status).toBe(200);
    const page = (await histRes.json()) as { items: unknown[] };
    expect(page.items.length).toBeGreaterThan(0);
    await expectValid("messages-page.json", page);
    for (const m of page.items) await expectValid("message.json", m);

    const messageId = (page.items[0] as { id: string }).id;

    // Reply listing (§7.2): GET …/messages/{id}/replies returns a messages-page.
    const repliesRes = await signedReq(
      alice,
      "GET",
      `/api/groups/${group.id}/channels/${channel.id}/messages/${messageId}/replies`,
    );
    expect(repliesRes.status).toBe(200);
    const repliesPage = (await repliesRes.json()) as { items: unknown[] };
    await expectValid("messages-page.json", repliesPage);

    // Reaction (§7.1): add one (PUT …/reactions/{key}), then list → each Reaction
    const rxAdd = await signedReq(
      alice,
      "PUT",
      `/api/groups/${group.id}/channels/${channel.id}/messages/${messageId}/reactions/heart`,
      { unicode: "❤️" },
    );
    expect([200, 201]).toContain(rxAdd.status);
    await expectValid("reaction.json", await rxAdd.json());

    const rxList = await signedReq(
      alice,
      "GET",
      `/api/groups/${group.id}/channels/${channel.id}/messages/${messageId}/reactions`,
    );
    expect(rxList.status).toBe(200);
    const reactions = (await rxList.json()) as { items: unknown[] };
    for (const r of reactions.items) await expectValid("reaction.json", r);
  });
});

// ---------------------------------------------------------------------------
// 4. Presence + privacy + follows (§6, §7.6).
// ---------------------------------------------------------------------------

describe("live schema validation: presence, privacy, follows (§6, §7.5, §7.6)", () => {
  test("PrivacySettings, Presence, Follow + FollowsResponse validate", async () => {
    const carol = await registerUserWithKey("carol");

    // PrivacySettings (§6.6): GET defaults
    const privRes = await signedReq(carol, "GET", "/api/me/privacy");
    expect(privRes.status).toBe(200);
    await expectValid("privacy-settings.json", await privRes.json());

    // Presence (§7.5): self-view of own presence
    const presRes = await signedReq(carol, "GET", `/api/users/${carol.handle}/presence`);
    expect(presRes.status).toBe(200);
    await expectValid("presence.json", await presRes.json());

    // Follow + FollowsResponse (§7.6): follow a public channel, then list
    const gRes = await signedReq(carol, "POST", "/api/groups", { name: "FollowG", tier: "public" });
    const fgroup = (await gRes.json()) as { id: string };
    const cRes = await signedReq(carol, "POST", `/api/groups/${fgroup.id}/channels`, {
      type: "text",
      tier: "public",
    });
    const fchannel = (await cRes.json()) as { id: string };

    const followRes = await signedReq(carol, "POST", "/api/me/follows", {
      channel: fchannel.id,
      groupId: fgroup.id,
    });
    expect(followRes.status).toBe(201);
    await expectValid("follow.json", await followRes.json());

    const followsRes = await signedReq(carol, "GET", "/api/me/follows");
    expect(followsRes.status).toBe(200);
    await expectValid("follows-response.json", await followsRes.json());
  });
});

// ---------------------------------------------------------------------------
// 5. Direct messages (§7.4).
// ---------------------------------------------------------------------------

describe("live schema validation: direct messages (§7.4)", () => {
  test("DmConversation/DmConversationsResponse + the dm.message envelope validate", async () => {
    const { deriveDmId } = await import("@forumall/shared");
    const dave = await registerUserWithKey("dave");
    const erin = await registerUserWithKey("erin");
    const dmId = deriveDmId(dave.actor, erin.actor);

    // erin connects so she receives the realtime dm.message envelope.
    const erinConn = await connectAuthenticated(erin);

    const send = await signedReq(dave, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "cmsg_dm",
      content: { mime: "text/plain", text: "hey erin" },
    });
    expect(send.status).toBe(201);
    // The stored message is a canonical Message object.
    await expectValid("message.json", await send.json());

    // WS dm.message envelope (§7.4)
    const dmEvt = await erinConn.ofType("dm.message");
    await expectValid("ws/dm-message.json", dmEvt);
    erinConn.close();

    // DmConversationsResponse + each DmConversation (erin's inbox)
    const listRes = await signedReq(erin, "GET", "/api/me/dms");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: unknown[] };
    expect(list.items.length).toBeGreaterThan(0);
    await expectValid("dm-conversations-response.json", list);
    for (const conv of list.items) await expectValid("dm-conversation.json", conv);
  });
});

// ---------------------------------------------------------------------------
// 6. Coverage assertion — how many endpoints/schemas did we validate?
// ---------------------------------------------------------------------------

describe("conformance coverage summary", () => {
  // Every schema the suite above MUST have validated at least one live response
  // against. Keep in sync with the calls above — a missing entry means a surface
  // silently stopped being checked.
  const REQUIRED_SCHEMAS = [
    "provider-discovery.json",
    "tiers-response.json",
    "user-keys-response.json",
    "providers-response.json",
    "discover-response.json",
    "problem-details.json",
    "group.json",
    "channel.json",
    "invite.json",
    "member.json",
    "messages-page.json",
    "message.json",
    "reaction.json",
    "privacy-settings.json",
    "presence.json",
    "follow.json",
    "follows-response.json",
    "dm-conversation.json",
    "dm-conversations-response.json",
    "ws/message-created.json",
    "ws/dm-message.json",
  ];

  test("every required schema was validated against a real response", () => {
    const missing = REQUIRED_SCHEMAS.filter((s) => !validated.has(s));
    if (missing.length > 0) {
      throw new Error(
        `These schemas were never validated against a live response: ${missing.join(", ")}`,
      );
    }
    expect(missing).toEqual([]);
  });

  test("prints the validated-endpoint count", () => {
    // Visible in test output: e.g. "conformance: validated 21 OFSCP schemas …".
    const sorted = [...validated].sort();
    console.log(
      `\nconformance: validated ${sorted.length} OFSCP v0.1 schemas against live responses:\n  ${sorted.join("\n  ")}\n`,
    );
    expect(validated.size).toBeGreaterThanOrEqual(REQUIRED_SCHEMAS.length);
  });
});
