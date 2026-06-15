/**
 * Group-creation-policy tests (Forumall extension, not OFSCP).
 *
 * Covers the admin-controlled "who may create groups" policy (PART C):
 *  - default (unset) policy is `open` → any authenticated user may create a group;
 *  - admin sets `admin-only` via `PUT /api/admin/group-policy` → a non-admin
 *    `POST /api/groups` → 403, while the admin still succeeds (201);
 *  - a non-admin `PUT /api/admin/group-policy` → 403;
 *  - an invalid policy value → 400;
 *  - `GET /api/provider` reflects the current policy.
 *
 * Drives the app in-process via `app.request(...)` against a temp SQLite file,
 * with reduced (TEST-ONLY) Argon2id cost so registration stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthBootstrapResponse, generateKeyPair, sign } from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-grouppolicy-"));
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

interface Signer {
  actor: string;
  keyId: string;
  privateKey: string;
}

/** Register a user + device key, returning a signer (first user → admin). */
async function registerUserWithKey(app: App, handle: string): Promise<Signer> {
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const dk = await app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(dk.status).toBe(201);
  const keyId = ((await dk.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}` };
}

/** Build a signed `app.request` (with optional JSON body). */
function signedRequest(app: App, signer: Signer, method: string, path: string, bodyObj?: unknown) {
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
  return app.request(path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

interface ProviderBody {
  domain: string;
  groupCreationPolicy: "open" | "admin-only";
}

describe("group-creation policy", () => {
  test("default (unset) is open: a non-admin can create a group, and GET reflects it", async () => {
    const { app } = freshApp("default-open");
    await registerUserWithKey(app, "owner"); // first user → admin (claims the slot)
    const peon = await registerUserWithKey(app, "peon"); // → not admin

    const get = await app.request("/api/provider");
    const body = (await get.json()) as ProviderBody;
    expect(body.groupCreationPolicy).toBe("open");

    const create = await signedRequest(app, peon, "POST", "/api/groups", { name: "Peon Guild" });
    expect(create.status).toBe(201);
  });

  test("admin-only: non-admin POST → 403, admin POST → 201, GET reflects the policy", async () => {
    const { app } = freshApp("admin-only");
    const admin = await registerUserWithKey(app, "owner"); // first user → admin
    const peon = await registerUserWithKey(app, "peon"); // → not admin

    const put = await signedRequest(app, admin, "PUT", "/api/admin/group-policy", {
      policy: "admin-only",
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { policy: string }).policy).toBe("admin-only");

    const get = await app.request("/api/provider");
    expect(((await get.json()) as ProviderBody).groupCreationPolicy).toBe("admin-only");

    // Non-admin is now blocked.
    const blocked = await signedRequest(app, peon, "POST", "/api/groups", { name: "Nope" });
    expect(blocked.status).toBe(403);

    // Admin still succeeds.
    const ok = await signedRequest(app, admin, "POST", "/api/groups", { name: "Admin Guild" });
    expect(ok.status).toBe(201);
  });

  test("a non-admin PUT to the policy route → 403", async () => {
    const { app } = freshApp("non-admin-put");
    await registerUserWithKey(app, "owner"); // claims admin
    const peon = await registerUserWithKey(app, "peon");

    const res = await signedRequest(app, peon, "PUT", "/api/admin/group-policy", {
      policy: "admin-only",
    });
    expect(res.status).toBe(403);
  });

  test("an invalid policy value → 400", async () => {
    const { app } = freshApp("invalid-policy");
    const admin = await registerUserWithKey(app, "owner");

    const res = await signedRequest(app, admin, "PUT", "/api/admin/group-policy", {
      policy: "everyone",
    });
    expect(res.status).toBe(400);
  });
});
