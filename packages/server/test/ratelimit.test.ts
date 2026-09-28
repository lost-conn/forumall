/**
 * Auth rate limiting (§4.1.5, reconciliation #26) tests.
 *
 * Two layers:
 *  - Unit tests for `provider/ratelimit.ts`'s `WindowLimiter` / `LoginBackoff`
 *    directly (fast, deterministic — an injectable `now` avoids real sleeps).
 *  - Integration tests driving `/api/auth/{register,login,device-keys}` via
 *    `app.request(...)` against a temp SQLite file, with tight `RATE_LIMIT_*`
 *    overrides so a handful of requests trips a limit deterministically.
 *
 * Every OTHER test file in this suite relies on the PRODUCTION rate-limit
 * defaults (they're generous enough — 5/10/10 per 60s — that no other test
 * registers/logs in that many times against one app instance) except
 * `conformance.test.ts`, which registers 6 users against one shared app/server
 * and opts out entirely via `RATE_LIMIT_ENABLED=false`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthBootstrapResponse, generateKeyPair } from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { LoginBackoff, WindowLimiter } from "../src/provider/ratelimit.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };

// ---------------------------------------------------------------------------
// Unit tests: WindowLimiter
// ---------------------------------------------------------------------------

describe("WindowLimiter", () => {
  test("allows up to the limit, then rejects with a positive Retry-After", () => {
    const l = new WindowLimiter(3, 60_000);
    expect(l.check("k").ok).toBe(true);
    expect(l.check("k").ok).toBe(true);
    expect(l.check("k").ok).toBe(true);
    const result = l.check("k");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  test("keys are independent", () => {
    const l = new WindowLimiter(1, 60_000);
    expect(l.check("a").ok).toBe(true);
    expect(l.check("b").ok).toBe(true);
    expect(l.check("a").ok).toBe(false);
    expect(l.check("b").ok).toBe(false);
  });

  test("resets after the window elapses (injected clock, no real sleep)", () => {
    const l = new WindowLimiter(1, 1000);
    expect(l.check("k", 0).ok).toBe(true);
    expect(l.check("k", 500).ok).toBe(false);
    expect(l.check("k", 1500).ok).toBe(true);
  });

  test("a hit over the limit still counts, so hammering doesn't reset the window early", () => {
    const l = new WindowLimiter(1, 1000);
    expect(l.check("k", 0).ok).toBe(true);
    expect(l.check("k", 100).ok).toBe(false);
    expect(l.check("k", 999).ok).toBe(false);
    expect(l.check("k", 1000).ok).toBe(true); // window has now elapsed
  });

  test("unlimited() never rejects", () => {
    const l = WindowLimiter.unlimited();
    for (let i = 0; i < 1000; i++) {
      expect(l.check("k").ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: LoginBackoff
// ---------------------------------------------------------------------------

describe("LoginBackoff", () => {
  test("locks out after repeated failures and resets on success", () => {
    const b = LoginBackoff.create();
    expect(b.check("alex", 0).ok).toBe(true);
    b.recordFailure("alex", 0);
    b.recordFailure("alex", 0);
    expect(b.check("alex", 0).ok).toBe(true); // 2 failures: not locked yet
    b.recordFailure("alex", 0); // 3rd failure crosses the threshold
    const locked = b.check("alex", 0);
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.retryAfterSeconds).toBeGreaterThan(0);

    b.recordSuccess("alex");
    expect(b.check("alex", 0).ok).toBe(true);
  });

  test("lockout expires on its own after enough time passes", () => {
    const b = LoginBackoff.create();
    for (let i = 0; i < 3; i++) b.recordFailure("alex", 0);
    expect(b.check("alex", 0).ok).toBe(false);
    expect(b.check("alex", 100_000).ok).toBe(true); // well past the (short, first) lockout
  });

  test("disabled() never locks out", () => {
    const b = LoginBackoff.disabled();
    for (let i = 0; i < 50; i++) b.recordFailure("alex", 0);
    expect(b.check("alex", 0).ok).toBe(true);
  });

  test("lockout is per-handle", () => {
    const b = LoginBackoff.create();
    for (let i = 0; i < 3; i++) b.recordFailure("alex", 0);
    expect(b.check("alex", 0).ok).toBe(false);
    expect(b.check("sam", 0).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: the auth endpoints wired to the limiters
// ---------------------------------------------------------------------------

let tmp: string;
let counter = 0;

function freshApp(overrides: Record<string, string> = {}) {
  const name = `rl-${counter++}`;
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN: "providera.test",
    ...overrides,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  return { app: createApp(config, { db }), config, db };
}

function register(
  app: ReturnType<typeof freshApp>["app"],
  handle: string,
  extraHeaders: Record<string, string> = {},
) {
  return app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
}

async function registerOk(
  app: ReturnType<typeof freshApp>["app"],
  handle: string,
): Promise<string> {
  const res = await register(app, handle);
  expect(res.status).toBe(201);
  const body = (await res.json()) as AuthBootstrapResponse;
  return body.bootstrap_token;
}

function login(
  app: ReturnType<typeof freshApp>["app"],
  handle: string,
  password: string,
  extraHeaders: Record<string, string> = {},
) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ handle, password }),
  });
}

function postDeviceKey(
  app: ReturnType<typeof freshApp>["app"],
  token: string,
  extraHeaders: Record<string, string> = {},
) {
  const { publicKey } = generateKeyPair();
  return app.request("/api/auth/device-keys", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "test" }),
  });
}

describe("auth rate limiting (integration)", () => {
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "forumall-ratelimit-"));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("POST /api/auth/register: the IP window limit returns 429 + Retry-After on the Nth+1 hit", async () => {
    const { app } = freshApp({
      RATE_LIMIT_REGISTER_MAX: "2",
      RATE_LIMIT_REGISTER_WINDOW_SECONDS: "60",
    });

    expect((await register(app, "alice")).status).toBe(201);
    expect((await register(app, "bob")).status).toBe(201);
    const third = await register(app, "carol");
    expect(third.status).toBe(429);
    const retryAfter = third.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  test("POST /api/auth/login: the Nth login from one IP gets 429 + Retry-After", async () => {
    const { app } = freshApp({ RATE_LIMIT_LOGIN_MAX: "2", RATE_LIMIT_LOGIN_WINDOW_SECONDS: "60" });
    // Three distinct handles/correct-password logins so the per-HANDLE window
    // and the login-backoff (which only counts FAILURES) never enter into it —
    // this isolates the per-IP window limit specifically.
    await registerOk(app, "dana");
    await registerOk(app, "erin");
    await registerOk(app, "finn");

    expect((await login(app, "dana", "correct-horse")).status).toBe(200);
    expect((await login(app, "erin", "correct-horse")).status).toBe(200);
    const third = await login(app, "finn", "correct-horse");
    expect(third.status).toBe(429);
    const retryAfter = third.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(third.headers.get("content-type")).toContain("application/problem+json");
  });

  test("POST /api/auth/login: repeated failed logins for a handle trigger backoff; a successful login resets it", async () => {
    // A generous window limit so only the (hardcoded, 3-failure) backoff can trip.
    const { app } = freshApp({ RATE_LIMIT_LOGIN_MAX: "1000" });
    await registerOk(app, "gale");

    expect((await login(app, "gale", "WRONG")).status).toBe(401);
    expect((await login(app, "gale", "WRONG")).status).toBe(401);
    // 3rd consecutive failure crosses LOCKOUT_STARTS_AFTER — even a CORRECT
    // password is now rejected with 429, not 200 (the lockout blocks before
    // the verify).
    expect((await login(app, "gale", "WRONG")).status).toBe(401);
    const locked = await login(app, "gale", "correct-horse");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("POST /api/auth/login: unknown and known handles are throttled identically", async () => {
    const { app } = freshApp({ RATE_LIMIT_LOGIN_MAX: "1000" });
    await registerOk(app, "known");

    // 3 failed attempts against a REAL handle …
    for (let i = 0; i < 3; i++) {
      expect((await login(app, "known", "WRONG")).status).toBe(401);
    }
    const knownLocked = await login(app, "known", "WRONG");
    expect(knownLocked.status).toBe(429);

    // … and 3 failed attempts against a handle that has never been registered
    // hit the exact same shape of response (backoff doesn't care whether the
    // account exists, so it can't be used to enumerate handles).
    for (let i = 0; i < 3; i++) {
      expect((await login(app, "nobody-here", "WRONG")).status).toBe(401);
    }
    const unknownLocked = await login(app, "nobody-here", "WRONG");
    expect(unknownLocked.status).toBe(429);
    expect(unknownLocked.headers.get("content-type")).toBe(knownLocked.headers.get("content-type"));
  });

  test("X-Forwarded-For is ignored unless TRUST_PROXY is set", async () => {
    const { app } = freshApp({ RATE_LIMIT_REGISTER_MAX: "1", TRUST_PROXY: "false" });
    // Two different claimed source IPs — but since the proxy header isn't
    // trusted, both requests fall back to the same "unknown peer" bucket
    // (there's no real socket under `app.request`), so the second one trips
    // the IP-keyed limit regardless of the header.
    expect((await register(app, "alice", { "x-forwarded-for": "203.0.113.1" })).status).toBe(201);
    const second = await register(app, "bob", { "x-forwarded-for": "203.0.113.2" });
    expect(second.status).toBe(429);
  });

  test("X-Forwarded-For (rightmost hop) is honoured when TRUST_PROXY=true", async () => {
    const { app } = freshApp({ RATE_LIMIT_REGISTER_MAX: "1", TRUST_PROXY: "true" });
    // Now the two distinct claimed IPs land in DIFFERENT buckets, so neither
    // is limited by the other.
    expect((await register(app, "alice", { "x-forwarded-for": "203.0.113.1" })).status).toBe(201);
    expect((await register(app, "bob", { "x-forwarded-for": "203.0.113.2" })).status).toBe(201);
    // A second hit from the SAME (trusted) address is still limited.
    const third = await register(app, "carol", { "x-forwarded-for": "203.0.113.1" });
    expect(third.status).toBe(429);
    // A spoofed, comma-separated list: only the RIGHTMOST entry counts, so
    // this is a third distinct bucket, not a repeat of .1's.
    expect(
      (
        await register(app, "dave", {
          "x-forwarded-for": "203.0.113.1, 203.0.113.9",
        })
      ).status,
    ).toBe(201);
  });

  test("POST /api/auth/device-keys is IP-rate-limited", async () => {
    const { app } = freshApp({ RATE_LIMIT_DEVICE_KEYS_MAX: "1" });
    const tokenA = await registerOk(app, "hana");
    const tokenB = await registerOk(app, "ivan");

    expect((await postDeviceKey(app, tokenA)).status).toBe(201);
    const second = await postDeviceKey(app, tokenB);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("POST /api/auth/device-keys is ALSO limited per the token's bound handle", async () => {
    // A tight limit (max=1) but TRUST_PROXY=true with a DIFFERENT claimed IP
    // per call, so the IP-keyed check alone would never block either call —
    // isolating the handle-keyed check. Register, then log back in to mint a
    // SECOND, still-valid, unconsumed bootstrap token for the SAME handle;
    // the handle-keyed check runs BEFORE the token is consumed, so the second
    // call is rejected purely for hitting "jules" twice, not because the
    // token itself is invalid.
    const { app } = freshApp({ RATE_LIMIT_DEVICE_KEYS_MAX: "1", TRUST_PROXY: "true" });
    const tokenA = await registerOk(app, "jules");
    const loginRes = await login(app, "jules", "correct-horse");
    expect(loginRes.status).toBe(200);
    const tokenB = ((await loginRes.json()) as AuthBootstrapResponse).bootstrap_token;

    const first = await postDeviceKey(app, tokenA, { "x-forwarded-for": "203.0.113.10" });
    expect(first.status).toBe(201); // consumes tokenA; ip:.10 count = 1, handle:jules count = 1
    const second = await postDeviceKey(app, tokenB, { "x-forwarded-for": "203.0.113.20" });
    expect(second.status).toBe(429); // different IP bucket, but the SAME handle bucket
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
