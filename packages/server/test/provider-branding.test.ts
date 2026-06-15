/**
 * Provider-branding tests (Forumall extension, not OFSCP).
 *
 * Covers `GET/PUT /api/provider` (step 2 of the provider-admin epic):
 *  - public `GET` returns the domain + documented defaults when unset;
 *  - admin `PUT` updates name / accent / icon and `GET` reflects it;
 *  - a non-admin `PUT` → 403;
 *  - invalid accent / over-long name → 400;
 *  - `null`/empty values clear a field (reverts to defaults).
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
  tmp = mkdtempSync(join(tmpdir(), "forumall-branding-"));
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

/** Signed `PUT /api/provider` with a JSON body. */
async function putProvider(app: App, signer: Signer, body: unknown): Promise<Response> {
  const path = "/api/provider";
  const text = JSON.stringify(body);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method: "PUT",
    path,
    body: text,
  });
  return app.request(path, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: text,
  });
}

interface BrandingBody {
  domain: string;
  name: string;
  iconUrl: string | null;
  accentColor: string | null;
}

describe("GET /api/provider (public)", () => {
  test("returns domain + defaults when unset, unauthenticated", async () => {
    const { app } = freshApp("public-defaults");
    const res = await app.request("/api/provider");
    expect(res.status).toBe(200);
    const body = (await res.json()) as BrandingBody;
    expect(body.domain).toBe(DOMAIN);
    expect(body.name).toBe(DOMAIN); // defaults to the domain
    expect(body.iconUrl).toBeNull();
    expect(body.accentColor).toBeNull();
  });
});

describe("PUT /api/provider (admin)", () => {
  test("admin updates name/accent/icon; public GET reflects it", async () => {
    const { app } = freshApp("admin-update");
    const admin = await registerUserWithKey(app, "owner"); // first user → admin

    const put = await putProvider(app, admin, {
      name: "Acme Commons",
      accentColor: "#FF8800",
      iconUrl: "/api/media/att_abc",
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as BrandingBody;
    expect(putBody.name).toBe("Acme Commons");
    expect(putBody.accentColor).toBe("#ff8800"); // normalized to lowercase
    expect(putBody.iconUrl).toBe("/api/media/att_abc");

    const get = await app.request("/api/provider");
    const getBody = (await get.json()) as BrandingBody;
    expect(getBody.name).toBe("Acme Commons");
    expect(getBody.accentColor).toBe("#ff8800");
    expect(getBody.iconUrl).toBe("/api/media/att_abc");
    expect(getBody.domain).toBe(DOMAIN);
  });

  test("a partial PUT leaves other fields untouched, and null clears a field", async () => {
    const { app } = freshApp("admin-partial");
    const admin = await registerUserWithKey(app, "owner");

    await putProvider(app, admin, { name: "Acme", accentColor: "#112233" });
    // Patch only the name; accent must persist.
    const put = await putProvider(app, admin, { name: "Acme Two" });
    const body = (await put.json()) as BrandingBody;
    expect(body.name).toBe("Acme Two");
    expect(body.accentColor).toBe("#112233");

    // Clear the accent with null; name persists, accent falls back to null.
    const cleared = await putProvider(app, admin, { accentColor: null });
    const clearedBody = (await cleared.json()) as BrandingBody;
    expect(clearedBody.accentColor).toBeNull();
    expect(clearedBody.name).toBe("Acme Two");

    // Clear the name with empty string → falls back to the domain.
    const clearedName = await putProvider(app, admin, { name: "" });
    const clearedNameBody = (await clearedName.json()) as BrandingBody;
    expect(clearedNameBody.name).toBe(DOMAIN);
  });

  test("non-admin PUT → 403", async () => {
    const { app } = freshApp("non-admin");
    await registerUserWithKey(app, "owner"); // first user → admin (claims the slot)
    const peon = await registerUserWithKey(app, "peon"); // → not admin

    const res = await putProvider(app, peon, { name: "Hijack" });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    // Branding stays at the default.
    const get = await app.request("/api/provider");
    const body = (await get.json()) as BrandingBody;
    expect(body.name).toBe(DOMAIN);
  });

  test("invalid accent / over-long name → 400", async () => {
    const { app } = freshApp("invalid");
    const admin = await registerUserWithKey(app, "owner");

    const badAccent = await putProvider(app, admin, { accentColor: "blurple" });
    expect(badAccent.status).toBe(400);

    const badShortHex = await putProvider(app, admin, { accentColor: "#fff" });
    expect(badShortHex.status).toBe(400);

    const longName = "x".repeat(200);
    const badName = await putProvider(app, admin, { name: longName });
    expect(badName.status).toBe(400);

    const badIcon = await putProvider(app, admin, { iconUrl: "javascript:alert(1)" });
    expect(badIcon.status).toBe(400);
  });
});
