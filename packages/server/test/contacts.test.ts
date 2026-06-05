/**
 * Contacts tests (spec §6.7).
 *
 * Covers the caller-facing request → accept → remove lifecycle (local pair, both
 * sides mirrored directly), the `areContacts` tier helper (true only once the
 * local accepted row exists), and the federation receiver (`request` records the
 * local `to` user's incoming pending; signer ≠ `from` → 403; `to` not local →
 * 404). The federation cross-provider signer is simulated with a
 * locally-registered key (real remote key resolution is P7).
 *
 * REST calls go over an ephemeral-port server with the shared `sign()` helper,
 * mirroring the DM suite. Argon2id cost is reduced (TEST-ONLY) so register stays
 * fast.
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
import { areContacts } from "../src/provider/contacts.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-contacts-"));
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

function boot(name: string, env: Record<string, string> = {}): Booted {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
    ...env,
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
  publicKey: string;
  actor: string;
  handle: string;
}

async function http(b: Booted, path: string, init: RequestInit): Promise<Response> {
  return fetch(`http://${b.server.hostname}:${b.server.port}${path}`, init);
}

async function registerUserWithKey(b: Booted, handle: string): Promise<Signer> {
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
  return { keyId, privateKey, publicKey, actor: `${handle}@${DOMAIN}`, handle };
}

/** A signed-HTTP request helper bound to a signer. */
async function signedReq(
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

interface ContactsList {
  contacts: { user: string; state: string; direction?: string }[];
  metadata: unknown[];
}

async function listContacts(b: Booted, who: Signer): Promise<ContactsList> {
  const res = await signedReq(b, who, "GET", "/api/me/contacts");
  expect(res.status).toBe(200);
  return (await res.json()) as ContactsList;
}

// ---------------------------------------------------------------------------
// Local lifecycle
// ---------------------------------------------------------------------------

describe("contacts local request → accept (§6.7)", () => {
  test("alice requests bob; bob sees incoming pending; bob accepts → both accepted", async () => {
    const b = boot("contacts-local");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");

    // alice → bob: outgoing pending, 201.
    const reqRes = await signedReq(b, alice, "POST", "/api/me/contacts", { user: bob.actor });
    expect(reqRes.status).toBe(201);
    const contact = (await reqRes.json()) as { user: string; state: string; direction: string };
    expect(contact.user).toBe(bob.actor);
    expect(contact.state).toBe("pending");
    expect(contact.direction).toBe("outgoing");

    // bob sees an incoming pending from alice.
    const bobList = await listContacts(b, bob);
    expect(bobList.contacts.length).toBe(1);
    expect(bobList.contacts[0]?.user).toBe(alice.actor);
    expect(bobList.contacts[0]?.state).toBe("pending");
    expect(bobList.contacts[0]?.direction).toBe("incoming");

    // Not yet contacts (still pending on both sides).
    expect(areContacts(b.db, "alice", bob.actor)).toBe(false);
    expect(areContacts(b.db, "bob", alice.actor)).toBe(false);

    // bob accepts → 200, accepted.
    const acc = await signedReq(
      b,
      bob,
      "POST",
      `/api/me/contacts/${encodeURIComponent(alice.actor)}/accept`,
    );
    expect(acc.status).toBe(200);
    const accContact = (await acc.json()) as { state: string };
    expect(accContact.state).toBe("accepted");

    // Both sides accepted.
    const aliceList = await listContacts(b, alice);
    expect(aliceList.contacts[0]?.state).toBe("accepted");
    const bobList2 = await listContacts(b, bob);
    expect(bobList2.contacts[0]?.state).toBe("accepted");

    // areContacts true both directions.
    expect(areContacts(b.db, "alice", bob.actor)).toBe(true);
    expect(areContacts(b.db, "bob", alice.actor)).toBe(true);
  });

  test("accept with no incoming pending → 404", async () => {
    const b = boot("contacts-accept-404");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");

    const acc = await signedReq(
      b,
      bob,
      "POST",
      `/api/me/contacts/${encodeURIComponent(alice.actor)}/accept`,
    );
    expect(acc.status).toBe(404);
  });
});

describe("contacts remove (§6.7)", () => {
  test("cancel outgoing pending removes both sides", async () => {
    const b = boot("contacts-cancel");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");

    await signedReq(b, alice, "POST", "/api/me/contacts", { user: bob.actor });

    const del = await signedReq(
      b,
      alice,
      "DELETE",
      `/api/me/contacts/${encodeURIComponent(bob.actor)}`,
    );
    expect(del.status).toBe(204);

    expect((await listContacts(b, alice)).contacts.length).toBe(0);
    expect((await listContacts(b, bob)).contacts.length).toBe(0);
  });

  test("decline incoming removes both sides", async () => {
    const b = boot("contacts-decline");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");

    await signedReq(b, alice, "POST", "/api/me/contacts", { user: bob.actor });

    // bob declines (DELETE his incoming).
    const del = await signedReq(
      b,
      bob,
      "DELETE",
      `/api/me/contacts/${encodeURIComponent(alice.actor)}`,
    );
    expect(del.status).toBe(204);

    expect((await listContacts(b, alice)).contacts.length).toBe(0);
    expect((await listContacts(b, bob)).contacts.length).toBe(0);
  });

  test("remove an established (accepted) contact removes both + areContacts false", async () => {
    const b = boot("contacts-remove-accepted");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");

    await signedReq(b, alice, "POST", "/api/me/contacts", { user: bob.actor });
    await signedReq(b, bob, "POST", `/api/me/contacts/${encodeURIComponent(alice.actor)}/accept`);
    expect(areContacts(b.db, "alice", bob.actor)).toBe(true);

    const del = await signedReq(
      b,
      alice,
      "DELETE",
      `/api/me/contacts/${encodeURIComponent(bob.actor)}`,
    );
    expect(del.status).toBe(204);

    expect((await listContacts(b, alice)).contacts.length).toBe(0);
    expect((await listContacts(b, bob)).contacts.length).toBe(0);
    expect(areContacts(b.db, "alice", bob.actor)).toBe(false);
    expect(areContacts(b.db, "bob", alice.actor)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Federation receiver
// ---------------------------------------------------------------------------

describe("contacts federation receiver (§6.7)", () => {
  test("signed request from alice → bob records bob's incoming pending", async () => {
    const b = boot("contacts-fed-request");
    // bob is the LOCAL user on this provider.
    const bob = await registerUserWithKey(b, "bob");
    // The cross-provider signer is simulated by a locally-registered key (real
    // remote key resolution is P7), so `from` is a locally-resolvable actor.
    const remoteSigner = await registerUserWithKey(b, "alice");
    const from = remoteSigner.actor;

    const res = await signedReq(b, remoteSigner, "POST", "/api/federation/contacts", {
      action: "request",
      from,
      to: bob.actor,
    });
    expect(res.status).toBe(200);

    // bob now holds an incoming pending row from alice@a.com.
    const bobList = await listContacts(b, bob);
    expect(bobList.contacts.length).toBe(1);
    expect(bobList.contacts[0]?.user).toBe(from);
    expect(bobList.contacts[0]?.state).toBe("pending");
    expect(bobList.contacts[0]?.direction).toBe("incoming");
    // Not contacts until bob accepts (and his accepted row exists).
    expect(areContacts(b.db, "bob", from)).toBe(false);
  });

  test("signer ≠ from → 403", async () => {
    const b = boot("contacts-fed-403");
    const bob = await registerUserWithKey(b, "bob");
    await registerUserWithKey(b, "alice");
    const mallory = await registerUserWithKey(b, "mallory");

    // mallory signs (as herself) but claims from = alice — signer ≠ from.
    const res = await signedReq(b, mallory, "POST", "/api/federation/contacts", {
      action: "request",
      from: `alice@${DOMAIN}`,
      to: bob.actor,
    });
    expect(res.status).toBe(403);
  });

  test("`to` not a local user → 404", async () => {
    const b = boot("contacts-fed-404");
    const remoteSigner = await registerUserWithKey(b, "alice");
    const from = remoteSigner.actor;

    const res = await signedReq(b, remoteSigner, "POST", "/api/federation/contacts", {
      action: "request",
      from,
      to: "ghost@providera.test",
    });
    expect(res.status).toBe(404);
  });

  test("federation accept then local accept reaches mutual accepted", async () => {
    const b = boot("contacts-fed-converge");
    const bob = await registerUserWithKey(b, "bob");
    const remoteSigner = await registerUserWithKey(b, "alice");
    const from = remoteSigner.actor;

    // Remote alice requests bob → bob incoming pending.
    await signedReq(b, remoteSigner, "POST", "/api/federation/contacts", {
      action: "request",
      from,
      to: bob.actor,
    });
    // bob accepts locally → bob's row accepted; areContacts(bob → alice) true.
    const acc = await signedReq(
      b,
      bob,
      "POST",
      `/api/me/contacts/${encodeURIComponent(from)}/accept`,
    );
    expect(acc.status).toBe(200);
    expect(areContacts(b.db, "bob", from)).toBe(true);
  });
});
