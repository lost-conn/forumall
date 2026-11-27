/**
 * Shared setup for the membership tests (spec §5.7, §7.2): an in-process app
 * per test (`app.request(...)`), a registered user with a device key, signed
 * requests, and direct membership seeding.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthBootstrapResponse, type Group, generateKeyPair, sign } from "@forumall/shared";
import { createApp } from "../../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../../src/config.ts";
import { type Db, openDb } from "../../src/db/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import { groupMembers } from "../../src/db/schema.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
export const DOMAIN = "providera.test";

export interface MembershipApp {
  readonly app: ReturnType<typeof createApp>;
  readonly config: Config;
  readonly db: Db;
}

export type App = MembershipApp["app"];

/**
 * Registers a temp data dir for the calling test file (removed after it) and
 * returns a factory for a fresh, migrated app in it.
 */
export function useMembershipApp(prefix: string): (name: string) => MembershipApp {
  let tmp = "";
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), `forumall-${prefix}-`));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  return (name) => {
    const base = loadConfig({
      DATA_DIR: tmp,
      DB_PATH: join(tmp, `${name}.sqlite`),
      WEB_DIR: join(tmp, `${name}-web`),
      DOMAIN,
    });
    const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
    const db = openDb(config.dbPath);
    migrate(db);
    const app = createApp(config, { testOnlySkipReplayWarmup: true, db });
    return { app, config, db };
  };
}

export interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
}

export async function registerUserWithKey(app: App, handle: string): Promise<Signer> {
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

export function signedRequest(
  app: App,
  signer: Signer,
  method: string,
  path: string,
  bodyObj?: unknown,
) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    // The canonical string carries the query on its own line (§4.4.2).
    path: path.split("?")[0] as string,
    query: path.includes("?") ? path.slice(path.indexOf("?") + 1) : "",
    ...(body !== undefined ? { body } : {}),
  });
  return app.request(path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

export async function createGroup(
  app: App,
  signer: Signer,
  body: Record<string, unknown>,
): Promise<Group> {
  const res = await signedRequest(app, signer, "POST", "/api/groups", body);
  expect(res.status).toBe(201);
  return (await res.json()) as Group;
}

/** Directly insert a membership row (bypassing the join flow) for setup. */
export function seedMember(
  db: Db,
  groupId: string,
  user: string,
  role: string,
  joinedAt = Date.now(),
) {
  db.drizzle.insert(groupMembers).values({ groupId, user, role, joinedAt }).run();
}

/** URL-encoded actor for use in a `{userRef}` path segment. */
export function ref(actor: string): string {
  return encodeURIComponent(actor);
}
