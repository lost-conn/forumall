/**
 * Provider-admin foundation tests (Forumall extension, not OFSCP).
 *
 * Covers the identity layer step 1 of the provider-admin epic:
 *  - first-user-is-admin bootstrap on a fresh DB;
 *  - subsequent registrants are NOT admin;
 *  - `ADMIN_HANDLES` promotion regardless of registration order;
 *  - `isProviderAdmin` resolution (persisted flag OR env list);
 *  - `requireAdmin` guard 403-vs-pass;
 *  - `GET /api/me` surfaces `isAdmin` on the self view.
 *
 * Drives the app in-process via `app.request(...)` against a temp SQLite file,
 * with reduced (TEST-ONLY) Argon2id cost so registration stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthBootstrapResponse, generateKeyPair, sign } from "@forumall/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { users } from "../src/db/schema.ts";
import { requireAdmin } from "../src/http/admin-guard.ts";
import { onError } from "../src/http/errors.ts";
import type { AppBindings } from "../src/http/types.ts";
import { countUsers, isProviderAdmin } from "../src/provider/admin.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-admin-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string, overrides: Partial<Config> = {}) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2, ...overrides });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db });
  return { app, config, db };
}

type App = ReturnType<typeof freshApp>["app"];

async function register(app: App, handle: string): Promise<string> {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as AuthBootstrapResponse).bootstrap_token;
}

/** Register a user + device key, returning the keypair + actor for signing. */
async function registerUserWithKey(app: App, handle: string) {
  const token = await register(app, handle);
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

/** Signed `GET /api/me`, returning the parsed JSON body. */
async function getMe(app: App, signer: { actor: string; keyId: string; privateKey: string }) {
  const path = "/api/me";
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method: "GET",
    path,
  });
  const res = await app.request(path, { method: "GET", headers });
  return { status: res.status, body: (await res.json()) as { isAdmin?: boolean } };
}

describe("first-user bootstrap", () => {
  test("first registrant becomes admin; second does not", () => {
    const { app, config, db } = freshApp("first-user");
    return (async () => {
      expect(countUsers(db)).toBe(0);
      await register(app, "owner");
      await register(app, "second");

      const owner = db.drizzle.select().from(users).where(eq(users.handle, "owner")).all()[0];
      const second = db.drizzle.select().from(users).where(eq(users.handle, "second")).all()[0];
      expect(owner?.isAdmin).toBe(true);
      expect(second?.isAdmin).toBe(false);

      expect(isProviderAdmin(db, config, "owner")).toBe(true);
      expect(isProviderAdmin(db, config, "second")).toBe(false);
    })();
  });
});

describe("ADMIN_HANDLES promotion", () => {
  test("a listed handle is admin regardless of registration order", async () => {
    const { app, config, db } = freshApp("admin-handles", {
      adminHandles: Object.freeze(["staff"]),
    });
    // First registrant (instance owner) → admin by the count rule.
    await register(app, "owner");
    // A later registrant whose handle is in ADMIN_HANDLES → admin by the env rule.
    await register(app, "staff");
    // An ordinary later registrant → not admin.
    await register(app, "regular");

    const staff = db.drizzle.select().from(users).where(eq(users.handle, "staff")).all()[0];
    expect(staff?.isAdmin).toBe(true);
    expect(isProviderAdmin(db, config, "owner")).toBe(true);
    expect(isProviderAdmin(db, config, "staff")).toBe(true);
    expect(isProviderAdmin(db, config, "regular")).toBe(false);
  });

  test("env list makes a handle admin even without the persisted flag", () => {
    const { app: _app, db } = freshApp("admin-handles-env");
    // Insert a plain user directly (no first-user bootstrap, no persisted flag).
    db.drizzle
      .insert(users)
      .values({ handle: "late", passwordHash: "x", createdAt: Date.now() })
      .run();
    const cfg = loadConfig({ DOMAIN, ADMIN_HANDLES: "Late" }); // case-insensitive
    expect(isProviderAdmin(db, cfg, "late")).toBe(true);
    expect(isProviderAdmin(db, cfg, "other")).toBe(false);
  });
});

describe("requireAdmin guard", () => {
  /** A tiny app that injects config/db/actor and mounts requireAdmin on /probe. */
  function probeApp(config: Config, db: ReturnType<typeof openDb>, actorHandle: string) {
    const app = new Hono<AppBindings>();
    app.use("*", async (c, next) => {
      c.set("config", config);
      c.set("db", db);
      c.set("actor", {
        actor: `${actorHandle}@${DOMAIN}`,
        handle: actorHandle,
        keyId: "k1",
        domain: DOMAIN,
      });
      await next();
    });
    app.get("/probe", requireAdmin(), (c) => c.json({ ok: true }));
    app.onError(onError); // render AppError as problem+json (mirrors the real app)
    return app;
  }

  test("403 for a non-admin, pass for an admin", async () => {
    const { config, db } = freshApp("guard");
    db.drizzle
      .insert(users)
      .values({ handle: "boss", passwordHash: "x", isAdmin: true, createdAt: Date.now() })
      .run();
    db.drizzle
      .insert(users)
      .values({ handle: "peon", passwordHash: "x", isAdmin: false, createdAt: Date.now() })
      .run();

    const adminRes = await probeApp(config, db, "boss").request("/probe");
    expect(adminRes.status).toBe(200);

    const nonAdminRes = await probeApp(config, db, "peon").request("/probe");
    expect(nonAdminRes.status).toBe(403);
    expect(nonAdminRes.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("GET /api/me exposes isAdmin (self view only)", () => {
  test("admin self sees isAdmin:true, non-admin self sees isAdmin:false", async () => {
    const { app } = freshApp("me-isadmin");
    const owner = await registerUserWithKey(app, "owner"); // first user → admin
    const other = await registerUserWithKey(app, "other"); // → not admin

    const ownerMe = await getMe(app, owner);
    expect(ownerMe.status).toBe(200);
    expect(ownerMe.body.isAdmin).toBe(true);

    const otherMe = await getMe(app, other);
    expect(otherMe.status).toBe(200);
    expect(otherMe.body.isAdmin).toBe(false);
  });
});
