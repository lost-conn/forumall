/**
 * Replay-store warm-up after a restart (OFSCP §4.5 "Restarts"; lost-conn/ofscp#17).
 *
 * Forumall's replay store is in-memory, so it forgets every nonce on restart.
 * Until local time passes T₀ + skew (T₀ = when the store began accepting
 * entries; skew = 300s) every signature timestamped earlier than T₀ + skew is
 * rejected with **503** `service_unavailable` + `Retry-After` ≥ the time left —
 * never 401. The WS `authenticate` handshake is exempt.
 *
 * These tests deliberately do NOT pass `testOnlySkipReplayWarmup`: the REST cases
 * inject an `InMemoryNonceStore` on a controllable clock (T₀ = construction
 * time), and the WS case boots with the production default store.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  ProblemDetailsSchema,
  type WsEnvelope,
  generateKeyPair,
  rfc3339Timestamp,
  sign,
  signProvider,
  signWsAuthenticate,
} from "@forumall/shared";

import { type AppDeps, createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { InMemoryNonceStore } from "../src/provider/nonce-store.ts";
import { getProviderSigningKey } from "../src/provider/signing-key.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";
const SKEW_MS = 300_000;
/** A fixed "boot" instant for the fake clock (any value works). */
const T0 = Date.parse("2026-06-01T12:00:00Z");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-warmup-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string, deps: Omit<AppDeps, "db"> = {}) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db, ...deps });
  return { app, config, db };
}

type App = ReturnType<typeof freshApp>["app"];

/** Register a user + device key (bootstrap-token flows: not signature-gated). */
async function registerUserWithKey(app: App, handle: string) {
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;
  const { publicKey, privateKey } = generateKeyPair();
  const res = await app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}` };
}

function signedList(
  app: App,
  signer: { actor: string; keyId: string; privateKey: string },
  timestampMs: number,
) {
  const path = "/api/auth/device-keys";
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method: "GET",
    path,
    timestamp: rfc3339Timestamp(new Date(timestampMs)),
  });
  return app.request(path, { method: "GET", headers });
}

/** A store on a fake clock; T₀ is the clock's value at construction. */
function clockedStore(start = T0) {
  const clock = { now: start };
  const store = new InMemoryNonceStore({ now: () => clock.now });
  return { clock, store };
}

async function expectWarmup503(res: Response, minRetryAfter: number) {
  expect(res.status).toBe(503);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(minRetryAfter);
  const body = ProblemDetailsSchema.parse(await res.json());
  expect(body.errorCode).toBe("service_unavailable");
  expect(body.type).toBe(`https://${DOMAIN}/problems/service_unavailable`);
}

describe("§4.5 Restarts: replay-store warm-up", () => {
  test("the default store's T₀ is its construction time", () => {
    const before = Date.now();
    const s = new InMemoryNonceStore();
    expect(s.startedAt).toBeGreaterThanOrEqual(before);
    expect(s.startedAt).toBeLessThanOrEqual(Date.now());
  });

  test("right after boot: a fresh signature → 503 + Retry-After ≥ remaining (never 401)", async () => {
    const { clock, store } = clockedStore();
    const { app } = freshApp("boot-503", { nonceStore: store });
    const signer = await registerUserWithKey(app, "alice");

    // Fresh, correctly signed, timestamped "now" = T₀: 300s of warm-up remain.
    await expectWarmup503(await signedList(app, signer, clock.now), 300);

    // 100s later, still warming up: ≥200s remain.
    clock.now = T0 + 100_000;
    await expectWarmup503(await signedList(app, signer, clock.now), 200);

    // A timestamp from just BEFORE the restart (still within skew) — the
    // dangerous case the rule exists for — is also refused with 503.
    await expectWarmup503(await signedList(app, signer, T0 - 1_000), 200);
  });

  test("the warm-up is checked before signature verification (a bad signature also 503s)", async () => {
    const { clock, store } = clockedStore();
    const { app } = freshApp("boot-badsig", { nonceStore: store });
    const signer = await registerUserWithKey(app, "alice");
    const forged = { ...signer, privateKey: generateKeyPair().privateKey };
    await expectWarmup503(await signedList(app, forged, clock.now), 300);
  });

  test("after the warm-up: a fresh signature → 200", async () => {
    const { clock, store } = clockedStore();
    const { app } = freshApp("after-warmup", { nonceStore: store });
    const signer = await registerUserWithKey(app, "alice");
    clock.now = T0 + SKEW_MS + 1_000;
    const res = await signedList(app, signer, clock.now);
    expect(res.status).toBe(200);
  });

  test("timestamp exactly at T₀ + skew is accepted; one ms earlier is not", async () => {
    const { clock, store } = clockedStore();
    const { app } = freshApp("boundary", { nonceStore: store });
    const signer = await registerUserWithKey(app, "alice");
    clock.now = T0 + SKEW_MS + 10_000;
    expect((await signedList(app, signer, T0 + SKEW_MS)).status).toBe(200);
    // A lagging client: local time is past T₀ + skew, but its timestamp is not.
    // Still 503; Retry-After is at least 1s (it must re-sign with a later clock).
    await expectWarmup503(await signedList(app, signer, T0 + SKEW_MS - 1), 1);
  });

  test("provider-signed (§8.1) requests are subject to the same warm-up", async () => {
    const { clock, store } = clockedStore();
    const { app, db } = freshApp("provider-signed", { nonceStore: store });
    const key = getProviderSigningKey(db);
    // A DM delete accepts a provider signature (§8.3, `requireActorOrProviderSignature`).
    const path = "/api/federation/dms/dm_x/messages/msg_x";
    const { headers } = signProvider({
      provider: DOMAIN,
      keyId: key.keyId,
      privateKey: key.privateKey,
      authority: DOMAIN,
      method: "DELETE",
      path,
      timestamp: rfc3339Timestamp(new Date(clock.now)),
    });
    const res = await app.request(path, { method: "DELETE", headers });
    await expectWarmup503(res, 300);
  });
});

// ---------------------------------------------------------------------------
// WS `authenticate` is exempt (server-issued per-connection challenge).
// ---------------------------------------------------------------------------

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function nextFrame(ws: WebSocket, pred: (f: WsEnvelope) => boolean): Promise<WsEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), 2000);
    const onMsg = (e: MessageEvent) => {
      const f = JSON.parse(String(e.data)) as WsEnvelope;
      if (!pred(f)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(f);
    };
    ws.addEventListener("message", onMsg);
  });
}

describe("§4.5 Restarts: the WS authenticate handshake is exempt", () => {
  test("production-default store, just booted: REST 503s but WS authenticates", async () => {
    // No nonceStore / no testOnlySkipReplayWarmup → exactly what src/index.ts does.
    const { app } = freshApp("ws-exempt");
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
    servers.push(server);

    const signer = await registerUserWithKey(app, "alice");

    // Sanity: the warm-up IS active for signed REST on this very server.
    await expectWarmup503(await signedList(app, signer, Date.now()), 290);

    const ws = new WebSocket(`ws://${server.hostname}:${server.port}/api/ws`);
    const challenge = nextFrame(ws, (f) => f.type === "auth.challenge");
    await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
    const { nonce } = (await challenge).data as { nonce: string };

    const timestamp = rfc3339Timestamp();
    const { signature } = signWsAuthenticate({
      privateKey: signer.privateKey,
      authority: DOMAIN,
      challengeNonce: nonce,
      timestamp,
    });
    const authed = nextFrame(ws, (f) => f.type === "authenticated" || f.type === "error");
    ws.send(
      JSON.stringify({
        id: "cli_auth",
        type: "authenticate",
        ts: rfc3339Timestamp(),
        data: { actor: signer.actor, keyId: signer.keyId, timestamp, signature },
      }),
    );
    const frame = await authed;
    expect(frame.type).toBe("authenticated");
    expect((frame.data as { actor: string }).actor).toBe(signer.actor);
    ws.close();
  });
});
