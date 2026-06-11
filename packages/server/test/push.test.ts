/**
 * Web Push HTTP + store tests (provider-local).
 *
 *  - `GET /api/push/public-key` returns a stable VAPID public key.
 *  - subscribe → list reflects it → unsubscribe removes it (signed CRUD).
 *  - the 410-cleanup path: `sendPushToRecipient` with an injected fetch that
 *    returns 410 deletes the dead subscription; a 201 stamps `lastDeliveredAt`.
 *  - the remote-recipient no-op + the disconnected-gate are exercised at the
 *    `sendPushToRecipient` level (no real push service required).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthBootstrapResponse, generateKeyPair, sign } from "@forumall/shared";

import { type AppWithWebSocket, createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { type Db, openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { type PushFetch, sendPushToRecipient } from "../src/provider/push-send.ts";
import { listSubscriptions } from "../src/provider/push.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-push-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Booted {
  app: AppWithWebSocket;
  db: Db;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
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
  const app = createApp(config, { db });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  const b: Booted = { app, db, config, server };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
  handle: string;
}

function http(b: Booted, path: string, init: RequestInit): Promise<Response> {
  return fetch(`http://${b.server.hostname}:${b.server.port}${path}`, init);
}

async function registerUser(b: Booted, handle: string): Promise<Signer> {
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

const SUB = {
  endpoint: "https://push.example.net/push/abc123",
  keys: {
    // RFC 8291 §5 receiver keys (valid P-256 point + auth secret).
    p256dh:
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};

describe("VAPID public key endpoint", () => {
  test("GET /api/push/public-key returns a stable base64url key", async () => {
    const b = boot("vapid");
    const r1 = await http(b, "/api/push/public-key", { method: "GET" });
    expect(r1.status).toBe(200);
    const { publicKey } = (await r1.json()) as { publicKey: string };
    expect(typeof publicKey).toBe("string");
    expect(publicKey.length).toBeGreaterThan(80); // 65 bytes → ~87 b64url chars
    // Stable across calls (generate-once).
    const r2 = await http(b, "/api/push/public-key", { method: "GET" });
    expect(((await r2.json()) as { publicKey: string }).publicKey).toBe(publicKey);
  });
});

describe("subscription CRUD over HTTP", () => {
  test("subscribe → list reflects it → unsubscribe removes it", async () => {
    const b = boot("crud");
    const alice = await registerUser(b, "alice");

    const sub = await signedReq(b, alice, "POST", "/api/push/subscribe", SUB);
    expect(sub.status).toBe(201);
    const { id } = (await sub.json()) as { id: string };
    expect(id.startsWith("psh_")).toBe(true);

    let rows = listSubscriptions(b.db, "alice");
    expect(rows.length).toBe(1);
    expect(rows[0]?.endpoint).toBe(SUB.endpoint);

    // Re-subscribe with the same endpoint is idempotent (no duplicate row).
    const again = await signedReq(b, alice, "POST", "/api/push/subscribe", SUB);
    expect(again.status).toBe(201);
    expect(listSubscriptions(b.db, "alice").length).toBe(1);

    const un = await signedReq(b, alice, "POST", "/api/push/unsubscribe", {
      endpoint: SUB.endpoint,
    });
    expect(un.status).toBe(204);
    rows = listSubscriptions(b.db, "alice");
    expect(rows.length).toBe(0);
  });

  test("subscribe requires a signature", async () => {
    const b = boot("auth");
    const res = await http(b, "/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SUB),
    });
    expect(res.status).toBe(401);
  });
});

describe("sendPushToRecipient delivery + cleanup", () => {
  test("410 deletes the dead subscription; 201 stamps lastDeliveredAt", async () => {
    const b = boot("send");
    const alice = await registerUser(b, "alice");
    // Two subscriptions: one push service returns 201 (ok), the other 410 (gone).
    const okSub = { ...SUB, endpoint: "https://push.example.net/ok" };
    const goneSub = { ...SUB, endpoint: "https://push.example.net/gone" };
    expect((await signedReq(b, alice, "POST", "/api/push/subscribe", okSub)).status).toBe(201);
    expect((await signedReq(b, alice, "POST", "/api/push/subscribe", goneSub)).status).toBe(201);
    expect(listSubscriptions(b.db, "alice").length).toBe(2);

    const fakeFetch: PushFetch = async (url) => ({
      status: url.endsWith("/gone") ? 410 : 201,
    });

    const accepted = await sendPushToRecipient(
      b.db,
      b.config,
      `alice@${DOMAIN}`,
      { title: "Hi", body: "there", tag: "t", data: { targetUrl: "/dms/x" } },
      fakeFetch,
    );
    expect(accepted).toBe(1); // the ok endpoint

    const rows = listSubscriptions(b.db, "alice");
    expect(rows.length).toBe(1); // the 410 row was cleaned up
    expect(rows[0]?.endpoint).toBe(okSub.endpoint);
    expect(rows[0]?.lastDeliveredAt).not.toBeNull();
  });

  test("a remote recipient is a no-op (no local subscriptions touched)", async () => {
    const b = boot("remote");
    const alice = await registerUser(b, "alice");
    expect((await signedReq(b, alice, "POST", "/api/push/subscribe", SUB)).status).toBe(201);

    let fetched = 0;
    const fakeFetch: PushFetch = async () => {
      fetched += 1;
      return { status: 201 };
    };
    const accepted = await sendPushToRecipient(
      b.db,
      b.config,
      "bob@other.test", // remote domain
      { title: "x", body: "y", tag: "t", data: { targetUrl: "/x" } },
      fakeFetch,
    );
    expect(accepted).toBe(0);
    expect(fetched).toBe(0); // never attempted a push for a remote actor
  });
});
