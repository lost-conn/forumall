/**
 * Auth tests (§4.1 local auth, §4.2 bootstrap tokens).
 *
 * Drives the app in-process via `app.request(...)` against a temp SQLite file.
 *
 * NOTE ON COST PARAMS: the integration tests build the app with **reduced**
 * Argon2id params (1 MiB / 1 iter / 1 lane) so the suite stays fast. This is a
 * TEST-ONLY override applied directly to the in-memory `Config`; it never goes
 * through the env loader. Production defaults (which the env loader pins to the
 * §4.1.4 minimums, and refuses to lower) are asserted separately in the
 * "config / argon2 defaults" block below.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  AuthBootstrapResponseSchema,
  ProblemDetailsSchema,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { bootstrapTokens, users } from "../src/db/schema.ts";
import {
  consumeBootstrapToken,
  issueBootstrapToken,
  verifyBootstrapToken,
} from "../src/provider/bootstrap-token.ts";
import { hashPassword, verifyPassword } from "../src/provider/password.ts";
import { eq } from "drizzle-orm";

const PROBLEM_CT = "application/problem+json";

/** Fast, TEST-ONLY Argon2id cost (far below §4.1.4 — never used in prod). */
const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-auth-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Build a fresh app with a temp DB and reduced Argon2 cost. `overrides` are
 * merged onto the resolved `Config` (after env validation) — that's how we drop
 * below the spec minimums for speed without weakening the production loader.
 */
function freshApp(name: string, overrides: Partial<Config> = {}) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2, ...overrides });
  const db = openDb(config.dbPath);
  migrate(db);
  return { app: createApp(config, { db }), config, db };
}

describe("POST /api/auth/register (§4.1.1)", () => {
  test("201 with a valid AuthBootstrapResponse", async () => {
    const { app } = freshApp("register-ok");
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "alice", password: "correct-horse" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AuthBootstrapResponse;
    const parsed = AuthBootstrapResponseSchema.parse(body);
    expect(parsed.token_type).toBe("bootstrap");
    expect(parsed.expires_in).toBe(300);
    expect(parsed.bootstrap_token.length).toBeGreaterThan(20);
  });

  test("accepts an optional recoveryEmail", async () => {
    const { app, db } = freshApp("register-email");
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "bob",
        password: "correct-horse",
        recoveryEmail: "bob@example.net",
      }),
    });
    expect(res.status).toBe(201);
    const row = db.drizzle.select().from(users).where(eq(users.handle, "bob")).all()[0];
    expect(row?.recoveryEmail).toBe("bob@example.net");
  });

  test("duplicate handle -> 409 problem+json", async () => {
    const { app } = freshApp("register-dup");
    const make = () =>
      app.request("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "carol", password: "correct-horse" }),
      });
    expect((await make()).status).toBe(201);
    const dup = await make();
    expect(dup.status).toBe(409);
    expect(dup.headers.get("content-type")).toContain(PROBLEM_CT);
    const parsed = ProblemDetailsSchema.parse(await dup.json());
    expect(parsed.errorCode).toBe("conflict");
  });

  test("password below min length -> 400 problem+json", async () => {
    const { app } = freshApp("register-shortpw");
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "dave", password: "short" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain(PROBLEM_CT);
    ProblemDetailsSchema.parse(await res.json());
  });

  test("invalid handle format -> 400", async () => {
    const { app } = freshApp("register-badhandle");
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "Has Spaces!", password: "correct-horse" }),
    });
    expect(res.status).toBe(400);
    ProblemDetailsSchema.parse(await res.json());
  });

  test("stored password hash is Argon2id (PHC prefix)", async () => {
    const { app, db } = freshApp("register-hash");
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "erin", password: "correct-horse" }),
    });
    const row = db.drizzle.select().from(users).where(eq(users.handle, "erin")).all()[0];
    expect(row?.passwordHash.startsWith("$argon2id$")).toBe(true);
    // Sanity: the embedded params reflect the (test) cost we configured.
    expect(row?.passwordHash).toContain("m=1024,t=1,p=1");
  });
});

describe("POST /api/auth/login (§4.1.2)", () => {
  async function registered(name: string) {
    const ctx = freshApp(name);
    await ctx.app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "frank", password: "correct-horse" }),
    });
    return ctx;
  }

  test("correct password -> 200 + bootstrap token", async () => {
    const { app } = await registered("login-ok");
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "frank", password: "correct-horse" }),
    });
    expect(res.status).toBe(200);
    const parsed = AuthBootstrapResponseSchema.parse(await res.json());
    expect(parsed.token_type).toBe("bootstrap");
    expect(parsed.expires_in).toBe(300);
  });

  test("wrong password and unknown handle -> byte-identical 401", async () => {
    const { app } = await registered("login-401");

    const wrongPw = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "frank", password: "WRONG" }),
    });
    const unknown = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "nobody", password: "WRONG" }),
    });

    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.headers.get("content-type")).toContain(PROBLEM_CT);

    // Bodies must be byte-identical (no handle enumeration).
    const a = await wrongPw.text();
    const b = await unknown.text();
    expect(a).toBe(b);
    ProblemDetailsSchema.parse(JSON.parse(a));
  });
});

describe("bootstrap-token helper (§4.2)", () => {
  test("consume returns the bound handle once; second call is null (single-use)", () => {
    const db = openDb(join(tmp, "bt-consume.sqlite"));
    migrate(db);
    const { token } = issueBootstrapToken(db, "grace", 300);

    expect(verifyBootstrapToken(db, token)).toEqual({ handle: "grace" });
    expect(consumeBootstrapToken(db, token)).toEqual({ handle: "grace" });
    // Now consumed.
    expect(consumeBootstrapToken(db, token)).toBeNull();
    expect(verifyBootstrapToken(db, token)).toBeNull();
  });

  test("unknown token -> null", () => {
    const db = openDb(join(tmp, "bt-unknown.sqlite"));
    migrate(db);
    expect(consumeBootstrapToken(db, "bt_nope")).toBeNull();
    expect(verifyBootstrapToken(db, "bt_nope")).toBeNull();
  });

  test("expired token is rejected", () => {
    const db = openDb(join(tmp, "bt-expired.sqlite"));
    migrate(db);
    const { token } = issueBootstrapToken(db, "heidi", 300);

    // Manipulate expires_at into the past directly in the DB.
    db.drizzle
      .update(bootstrapTokens)
      .set({ expiresAt: Date.now() - 1000 })
      .run();

    expect(verifyBootstrapToken(db, token)).toBeNull();
    expect(consumeBootstrapToken(db, token)).toBeNull();
  });

  test("only the token hash is stored, never the plaintext", () => {
    const db = openDb(join(tmp, "bt-hash.sqlite"));
    migrate(db);
    const { token } = issueBootstrapToken(db, "ivan", 300);
    const row = db.drizzle.select().from(bootstrapTokens).all()[0];
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.tokenHash.length).toBe(64); // sha256 hex
    expect(token.startsWith("bt_")).toBe(true);
  });
});

describe("password hashing (§4.1.4)", () => {
  test("hash is verifiable and salt is random per call", () => {
    const h1 = hashPassword("pw", FAST_ARGON2);
    const h2 = hashPassword("pw", FAST_ARGON2);
    expect(h1).not.toBe(h2); // distinct random salts
    expect(h1.startsWith("$argon2id$")).toBe(true);
    expect(verifyPassword("pw", h1)).toBe(true);
    expect(verifyPassword("nope", h1)).toBe(false);
  });

  test("verify returns false on a malformed hash (no throw)", () => {
    expect(verifyPassword("pw", "not-a-phc-string")).toBe(false);
    expect(verifyPassword("pw", "$argon2id$broken")).toBe(false);
  });
});

describe("config / argon2 defaults (§4.1.4 minimums)", () => {
  test("default cost params equal the spec minimums", () => {
    const c = loadConfig({});
    expect(c.argon2.memoryKib).toBe(65_536); // 64 MiB
    expect(c.argon2.iterations).toBe(3);
    expect(c.argon2.parallelism).toBe(4);
    expect(c.bootstrapTtlSeconds).toBe(300);
  });

  test("env loader refuses to go below the minimums", () => {
    expect(() => loadConfig({ ARGON2_MEMORY_KIB: "1024" })).toThrow();
    expect(() => loadConfig({ ARGON2_ITERATIONS: "1" })).toThrow();
    expect(() => loadConfig({ ARGON2_PARALLELISM: "1" })).toThrow();
  });

  test("env loader allows raising the cost", () => {
    const c = loadConfig({ ARGON2_MEMORY_KIB: "131072", ARGON2_ITERATIONS: "4" });
    expect(c.argon2.memoryKib).toBe(131_072);
    expect(c.argon2.iterations).toBe(4);
  });
});
