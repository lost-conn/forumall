/**
 * DM conversation-pointer hygiene (OFSCP §7.4).
 *
 *  - "A provider MUST serve the counterparty in canonical form, normalizing any
 *    non-canonical value stored before this rule" — migration
 *    `0036_dm_conversations_canonical_counterparty` rewrites legacy values.
 *  - "A stored pointer whose counterparty does not derive its dmId together with
 *    the owner MUST be ignored — neither listed nor acted on — or deleted."
 *    Forumall ignores such a row: it is not listed, cannot hold a read marker,
 *    and never makes this provider send a request (reaction/edit/delete forward).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type DmConversation,
  deriveDmId,
  generateKeyPair,
  sign,
} from "@forumall/shared";
import { eq } from "drizzle-orm";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { dmConversations, readMarkers } from "../src/db/schema.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";
const MIGRATION = "0036_dm_conversations_canonical_counterparty";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-dm-hygiene-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshApp(name: string) {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  // Every outbound provider request is recorded (and answered 200).
  const outbound: string[] = [];
  const app = createApp(config, {
    db,
    federationFetch: async (_domain, request) => {
      outbound.push(`${request.method} ${request.url}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { app, db, outbound };
}

type App = ReturnType<typeof freshApp>["app"];
type TestDb = ReturnType<typeof freshApp>["db"];

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
}

async function registerUserWithKey(app: App, handle: string): Promise<Signer> {
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse-battery" }),
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

/** Write a raw `dm_conversations` row, bypassing every write-path check. */
function insertRawConversation(db: TestDb, owner: string, dmId: string, counterparty: string) {
  db.sqlite
    .query(
      "INSERT INTO dm_conversations (owner, dm_id, counterparty, updated_at, last_message_seq) VALUES (?, ?, ?, ?, 0)",
    )
    .run(owner, dmId, counterparty, Date.now());
}

async function listConversations(app: App, signer: Signer): Promise<DmConversation[]> {
  const res = await signedRequest(app, signer, "GET", "/api/me/dms");
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: DmConversation[] }).items;
}

test("migration normalizes a legacy non-canonical counterparty, served canonically", async () => {
  const { app, db } = freshApp("hygiene-migration");
  const alice = await registerUserWithKey(app, "alice");
  const dmId = deriveDmId(alice.actor, "dave@remote.example");
  // Stored before the canonical-`with` rule: uppercase handle/host + default port.
  insertRawConversation(db, "alice", dmId, "DAVE@Remote.Example:443");
  // A value that can never be made canonical is left for the runtime rule.
  insertRawConversation(db, "alice", "dm_junk", "not an actor");

  // Re-run the migration as if upgrading a database that predates it.
  db.sqlite.query("DELETE FROM _migrations WHERE id = ?").run(MIGRATION);
  expect(migrate(db)).toEqual([MIGRATION]);

  const rows = db.drizzle
    .select({ dmId: dmConversations.dmId, counterparty: dmConversations.counterparty })
    .from(dmConversations)
    .where(eq(dmConversations.owner, "alice"))
    .all()
    .sort((a, b) => a.dmId.localeCompare(b.dmId));
  expect(rows).toEqual(
    [
      { dmId, counterparty: "dave@remote.example" },
      { dmId: "dm_junk", counterparty: "not an actor" },
    ].sort((a, b) => a.dmId.localeCompare(b.dmId)),
  );

  const items = await listConversations(app, alice);
  expect(items.map((c) => [c.id, c.participants])).toEqual([
    [dmId, [alice.actor, "dave@remote.example"]],
  ]);
});

test("a pointer whose counterparty does not derive its dmId is ignored", async () => {
  const { app, db, outbound } = freshApp("hygiene-ignore");
  const alice = await registerUserWithKey(app, "alice");
  // dmId of alice↔carol, but the stored counterparty is someone else (remote).
  const dmId = deriveDmId(alice.actor, "carol@remote.example");
  insertRawConversation(db, "alice", dmId, "mallory@remote.example");

  // Not listed.
  expect(await listConversations(app, alice)).toEqual([]);

  // Cannot hold a read marker, and the summary does not list the scope.
  const patch = await signedRequest(app, alice, "PATCH", "/api/me/read-markers", {
    markers: [{ scopeId: dmId, lastReadSeq: 1 }],
  });
  expect(patch.status).toBe(200);
  expect(
    db.drizzle.select().from(readMarkers).where(eq(readMarkers.handle, "alice")).all(),
  ).toEqual([]);
  const summary = await signedRequest(app, alice, "GET", "/api/me/read-markers");
  const scopes = ((await summary.json()) as { scopes: { scopeId: string }[] }).scopes;
  expect(scopes.map((s) => s.scopeId)).not.toContain(dmId);

  // Triggers no outbound request: reaction add/remove, edit and delete of a
  // "sent" message would otherwise be forwarded to the counterparty's provider.
  const base = `/api/dms/${dmId}/messages/msg_x`;
  await signedRequest(app, alice, "PUT", `${base}/reactions/heart`);
  await signedRequest(app, alice, "DELETE", `${base}/reactions/heart`);
  await signedRequest(app, alice, "PATCH", base, {
    content: { text: "edited", mime: "text/plain" },
  });
  await signedRequest(app, alice, "DELETE", base);
  expect(outbound).toEqual([]);

  // Nor does it make the owner a participant of the thread.
  const read = await signedRequest(app, alice, "GET", `/api/dms/${dmId}/messages`);
  expect(read.status).toBe(404);
});

test("a valid pointer PUT replaces an ignored row's counterparty", async () => {
  const { app, db } = freshApp("hygiene-replace");
  const alice = await registerUserWithKey(app, "alice");
  const dmId = deriveDmId(alice.actor, "carol@remote.example");
  insertRawConversation(db, "alice", dmId, "mallory@remote.example");

  const res = await signedRequest(app, alice, "PUT", `/api/me/dms/${dmId}`, {
    with: "carol@remote.example",
  });
  expect(res.status).toBe(200);
  expect((await listConversations(app, alice)).map((c) => [c.id, c.participants])).toEqual([
    [dmId, [alice.actor, "carol@remote.example"]],
  ]);
});
