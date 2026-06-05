/**
 * Device-key registration (§4.3), public key discovery (§4.6), and revocation
 * (§4.7) tests. Drives the app in-process via `app.request(...)` against a temp
 * SQLite file, plus direct unit calls of the revocation/resolution helpers.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast — see auth.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  ProblemDetailsSchema,
  UserKeysResponseSchema,
  generateKeyPair,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { resolveActorKeys, revokeDeviceKey } from "../src/provider/device-keys.ts";

const PROBLEM_CT = "application/problem+json";
const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-devkeys-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string, overrides: Partial<Config> = {}) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN: "providera.test",
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2, ...overrides });
  const db = openDb(config.dbPath);
  migrate(db);
  return { app: createApp(config, { db }), config, db };
}

/** Register a user and return its bootstrap token. */
async function registerUser(app: ReturnType<typeof freshApp>["app"], handle: string) {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as AuthBootstrapResponse;
  return body.bootstrap_token;
}

function postDeviceKey(
  app: ReturnType<typeof freshApp>["app"],
  token: string,
  body: Record<string, unknown>,
) {
  return app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/device-keys (§4.3)", () => {
  test("full flow: register → token → device-key 201 → appears at keys endpoint", async () => {
    const { app, config } = freshApp("flow");
    const token = await registerUser(app, "alice");
    const { publicKey } = generateKeyPair();

    const res = await postDeviceKey(app, token, {
      public_key: publicKey,
      algorithm: "Ed25519",
      device_name: "Firefox on Linux",
    });
    expect(res.status).toBe(201);
    const reg = (await res.json()) as { key_id: string; created_at: string };
    expect(reg.key_id.startsWith("dk_")).toBe(true);
    expect(typeof reg.created_at).toBe("string");

    // The key now appears at the public keys endpoint.
    const keysRes = await app.request("/.well-known/ofscp/users/alice/keys");
    expect(keysRes.status).toBe(200);
    const parsed = UserKeysResponseSchema.parse(await keysRes.json());
    expect(parsed.actor).toBe(`alice@${config.domain}`);
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]?.key_id).toBe(reg.key_id);
    expect(parsed.keys[0]?.public_key).toBe(publicKey);
    expect(parsed.keys[0]?.algorithm).toBe("Ed25519");

    // cache_until is present and in the future.
    expect(new Date(parsed.cache_until).getTime()).toBeGreaterThan(Date.now());
  });

  test("bootstrap token is single-use: second registration → 401", async () => {
    const { app } = freshApp("single-use");
    const token = await registerUser(app, "bob");
    const { publicKey } = generateKeyPair();

    const first = await postDeviceKey(app, token, {
      public_key: publicKey,
      algorithm: "Ed25519",
      device_name: "dev1",
    });
    expect(first.status).toBe(201);

    const second = await postDeviceKey(app, token, {
      public_key: generateKeyPair().publicKey,
      algorithm: "Ed25519",
      device_name: "dev2",
    });
    expect(second.status).toBe(401);
    expect(second.headers.get("content-type")).toContain(PROBLEM_CT);
    ProblemDetailsSchema.parse(await second.json());
  });

  test("client cannot override the bound handle", async () => {
    const { app, config } = freshApp("no-override");
    await registerUser(app, "victim"); // exists, but we won't bind to it
    const token = await registerUser(app, "owner");
    const { publicKey } = generateKeyPair();

    const res = await postDeviceKey(app, token, {
      public_key: publicKey,
      algorithm: "Ed25519",
      device_name: "dev",
      handle: "victim",
      user_handle: "victim",
    });
    expect(res.status).toBe(201);

    // Bound to the token's handle (owner), not the body's (victim).
    const ownerKeys = UserKeysResponseSchema.parse(
      await (await app.request("/.well-known/ofscp/users/owner/keys")).json(),
    );
    expect(ownerKeys.actor).toBe(`owner@${config.domain}`);
    expect(ownerKeys.keys).toHaveLength(1);
    expect(ownerKeys.keys[0]?.public_key).toBe(publicKey);

    const victimKeys = UserKeysResponseSchema.parse(
      await (await app.request("/.well-known/ofscp/users/victim/keys")).json(),
    );
    expect(victimKeys.keys).toHaveLength(0);
  });

  test("missing bootstrap token → 401", async () => {
    const { app } = freshApp("no-token");
    const res = await app.request("/api/auth/device-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_key: generateKeyPair().publicKey, device_name: "d" }),
    });
    expect(res.status).toBe(401);
    ProblemDetailsSchema.parse(await res.json());
  });

  test("invalid/unknown bootstrap token → 401", async () => {
    const { app } = freshApp("bad-token");
    const res = await postDeviceKey(app, "bt_nope", {
      public_key: generateKeyPair().publicKey,
      algorithm: "Ed25519",
      device_name: "d",
    });
    expect(res.status).toBe(401);
  });

  test("algorithm != Ed25519 → 400", async () => {
    const { app } = freshApp("bad-alg");
    const token = await registerUser(app, "carol");
    const res = await postDeviceKey(app, token, {
      public_key: generateKeyPair().publicKey,
      algorithm: "RSA",
      device_name: "d",
    });
    expect(res.status).toBe(400);
    ProblemDetailsSchema.parse(await res.json());

    // Token was NOT consumed by a rejected request: a valid retry still works.
    const ok = await postDeviceKey(app, token, {
      public_key: generateKeyPair().publicKey,
      algorithm: "Ed25519",
      device_name: "d",
    });
    expect(ok.status).toBe(201);
  });

  test("malformed public_key → 400", async () => {
    const { app } = freshApp("bad-key");
    const token = await registerUser(app, "dave");
    const res = await postDeviceKey(app, token, {
      public_key: "not-valid-key-material!!!",
      algorithm: "Ed25519",
      device_name: "d",
    });
    expect(res.status).toBe(400);
    ProblemDetailsSchema.parse(await res.json());
  });

  test("public_key of the wrong length → 400", async () => {
    const { app } = freshApp("short-key");
    const token = await registerUser(app, "erin");
    const res = await postDeviceKey(app, token, {
      // base64 of 16 bytes, not 32.
      public_key: Buffer.from(new Uint8Array(16)).toString("base64"),
      algorithm: "Ed25519",
      device_name: "d",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /.well-known/ofscp/users/{handle}/keys (§4.6)", () => {
  test("unknown handle → 200 with empty keys (no enumeration)", async () => {
    const { app, config } = freshApp("unknown-handle");
    const res = await app.request("/.well-known/ofscp/users/ghost/keys");
    expect(res.status).toBe(200);
    const parsed = UserKeysResponseSchema.parse(await res.json());
    expect(parsed.actor).toBe(`ghost@${config.domain}`);
    expect(parsed.keys).toHaveLength(0);
    expect(new Date(parsed.cache_until).getTime()).toBeGreaterThan(Date.now());
  });

  test("cache_until honors the configured window", async () => {
    const { app } = freshApp("cache-window", { userKeysCacheSeconds: 120 });
    const before = Date.now();
    const res = await app.request("/.well-known/ofscp/users/whoever/keys");
    const parsed = UserKeysResponseSchema.parse(await res.json());
    const cacheUntil = new Date(parsed.cache_until).getTime();
    expect(cacheUntil).toBeGreaterThanOrEqual(before + 120 * 1000 - 2000);
    expect(cacheUntil).toBeLessThanOrEqual(Date.now() + 120 * 1000 + 2000);
  });
});

describe("revocation + actor-key resolution (§4.7)", () => {
  test("revokeDeviceKey omits the key from the endpoint and resolveActorKeys", async () => {
    const { app, db } = freshApp("revoke");
    const token = await registerUser(app, "frank");
    const { publicKey } = generateKeyPair();
    const reg = (await (
      await postDeviceKey(app, token, {
        public_key: publicKey,
        algorithm: "Ed25519",
        device_name: "d",
      })
    ).json()) as { key_id: string };

    // Present before revocation.
    expect(resolveActorKeys(db, "frank")).toHaveLength(1);

    // Revoke.
    expect(revokeDeviceKey(db, "frank", reg.key_id)).toBe(true);

    // Gone from resolveActorKeys.
    expect(resolveActorKeys(db, "frank")).toHaveLength(0);

    // Gone from the keys endpoint.
    const parsed = UserKeysResponseSchema.parse(
      await (await app.request("/.well-known/ofscp/users/frank/keys")).json(),
    );
    expect(parsed.keys).toHaveLength(0);
  });

  test("revokeDeviceKey only affects the owning handle; double-revoke is false", async () => {
    const { app, db } = freshApp("revoke-owner");
    const tokA = await registerUser(app, "grace");
    const tokB = await registerUser(app, "heidi");
    const regA = (await (
      await postDeviceKey(app, tokA, {
        public_key: generateKeyPair().publicKey,
        algorithm: "Ed25519",
        device_name: "d",
      })
    ).json()) as { key_id: string };
    await postDeviceKey(app, tokB, {
      public_key: generateKeyPair().publicKey,
      algorithm: "Ed25519",
      device_name: "d",
    });

    // Wrong owner cannot revoke grace's key.
    expect(revokeDeviceKey(db, "heidi", regA.key_id)).toBe(false);
    expect(resolveActorKeys(db, "grace")).toHaveLength(1);

    // Correct owner revokes; a second revoke is a no-op.
    expect(revokeDeviceKey(db, "grace", regA.key_id)).toBe(true);
    expect(revokeDeviceKey(db, "grace", regA.key_id)).toBe(false);

    // Unknown key id → false.
    expect(revokeDeviceKey(db, "grace", "dk_nonexistent")).toBe(false);
  });
});
