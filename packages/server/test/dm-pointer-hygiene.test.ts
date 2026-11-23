/**
 * DM conversation-pointer hygiene (OFSCP §7.4).
 *
 *  - "A provider MUST serve the counterparty in canonical form, normalizing any
 *    non-canonical value stored before this rule" — migration
 *    `0036_dm_conversations_canonical_counterparty` rewrites legacy values.
 *  - "A stored pointer whose counterparty does not derive its dmId together with
 *    the owner MUST be ignored — neither listed nor acted on — or deleted."
 *    Migration 0036 deletes such rows (and their markers); at runtime any that
 *    remain are ignored: not listed, not a participant, cannot hold a read
 *    marker, and never make this provider send a request.
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
import { migrate, migrationDomain } from "../src/db/migrate.ts";
import { dmConversations, readMarkers } from "../src/db/schema.ts";
import { isDmThreadParticipant, upsertDmPointer } from "../src/provider/dms.ts";

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
function insertRawConversation(
  db: TestDb,
  owner: string,
  dmId: string,
  counterparty: string,
  lastMessageSeq = 0,
) {
  db.sqlite
    .query(
      "INSERT INTO dm_conversations (owner, dm_id, counterparty, updated_at, last_message_seq) VALUES (?, ?, ?, ?, ?)",
    )
    .run(owner, dmId, counterparty, Date.now(), lastMessageSeq);
}

/** A snapshot of both tables 0036 touches, for "nothing changed" checks. */
function snapshot(db: TestDb) {
  return {
    conversations: db.sqlite.query("SELECT * FROM dm_conversations ORDER BY owner, dm_id").all(),
    markers: db.sqlite.query("SELECT * FROM read_markers ORDER BY handle, scope_id").all(),
  };
}

function isApplied(db: TestDb): boolean {
  return db.sqlite.query("SELECT 1 FROM _migrations WHERE id = ?").all(MIGRATION).length > 0;
}

function insertRawMarker(db: TestDb, handle: string, scopeId: string, seq: number) {
  db.sqlite
    .query(
      "INSERT INTO read_markers (handle, scope_id, last_read_seq, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(handle, scopeId, seq, Date.now());
}

async function listConversations(app: App, signer: Signer): Promise<DmConversation[]> {
  const res = await signedRequest(app, signer, "GET", "/api/me/dms");
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: DmConversation[] }).items;
}

test("migration 0036 canonicalizes a fixable counterparty, deletes inconsistent pointers, keeps rows with messages", async () => {
  const { app, db } = freshApp("hygiene-migration");
  const alice = await registerUserWithKey(app, "alice");
  const dmId = deriveDmId(alice.actor, "dave@remote.example");
  // Stored before the canonical-`with` rule: uppercase handle/host + default port.
  insertRawConversation(db, "alice", dmId, "DAVE@Remote.Example:443");
  // A pure pointer whose counterparty does not derive its dmId, with a marker.
  const bogus = deriveDmId(alice.actor, "carol@remote.example");
  insertRawConversation(db, "alice", bogus, "mallory@remote.example");
  insertRawMarker(db, "alice", bogus, 42);
  // A value that can never be made canonical, with a marker.
  insertRawConversation(db, "alice", "dm_junk", "not an actor");
  insertRawMarker(db, "alice", "dm_junk", 7);
  // A row holding received messages that fails derivation (e.g. an author once
  // stored as `erin@remote.example:443`): kept, with its marker, but ignored.
  const legacy = deriveDmId(alice.actor, "erin@remote.example:443");
  insertRawConversation(db, "alice", legacy, "erin@remote.example:443", 5);
  insertRawMarker(db, "alice", legacy, 5);
  // An unrelated marker is kept.
  insertRawMarker(db, "alice", dmId, 3);

  // Re-run the migration as if upgrading a database that predates it.
  db.sqlite.query("DELETE FROM _migrations WHERE id = ?").run(MIGRATION);
  const log: string[] = [];
  expect(migrate(db, { domain: DOMAIN, log: (l) => log.push(l) })).toEqual([MIGRATION]);
  expect(log).toEqual([
    "[migrate] 0036 dm_conversations: 1 counterparties canonicalized, 2 inconsistent pointers deleted, 1 inconsistent rows with received messages kept (ignored at runtime)",
  ]);

  const rows = db.drizzle
    .select({ dmId: dmConversations.dmId, counterparty: dmConversations.counterparty })
    .from(dmConversations)
    .where(eq(dmConversations.owner, "alice"))
    .all()
    .sort((x, y) => x.dmId.localeCompare(y.dmId));
  expect(rows).toEqual(
    [
      { dmId, counterparty: "dave@remote.example" },
      { dmId: legacy, counterparty: "erin@remote.example:443" },
    ].sort((x, y) => x.dmId.localeCompare(y.dmId)),
  );
  const markers = db.drizzle
    .select({ scopeId: readMarkers.scopeId })
    .from(readMarkers)
    .where(eq(readMarkers.handle, "alice"))
    .all()
    .map((m) => m.scopeId)
    .sort();
  expect(markers).toEqual([dmId, legacy].sort());

  // Only the consistent row is listed (the kept one is ignored at runtime).
  const items = await listConversations(app, alice);
  expect(items.map((c) => [c.id, c.participants])).toEqual([
    [dmId, [alice.actor, "dave@remote.example"]],
  ]);
});

test("migration 0036 with no / the default DOMAIN changes nothing and stays unapplied", async () => {
  const { db } = freshApp("hygiene-migration-no-domain");
  const bogus = deriveDmId(`alice@${DOMAIN}`, "carol@remote.example");
  insertRawConversation(db, "alice", bogus, "mallory@remote.example");
  insertRawMarker(db, "alice", bogus, 42);
  insertRawConversation(
    db,
    "alice",
    deriveDmId(`alice@${DOMAIN}`, "bob@remote.example"),
    "BOB@remote.example",
  );
  db.sqlite.query("DELETE FROM _migrations WHERE id = ?").run(MIGRATION);
  const before = snapshot(db);

  // Boot with DOMAIN unset (or the .env.example placeholder) passes no domain.
  for (const env of [{}, { DOMAIN: "forum.example.com" }]) {
    const config = loadConfig({ DATA_DIR: tmp, ...env });
    expect(config.domainIsDefault).toBe(true);
    const deferred: string[] = [];
    expect(
      migrate(db, { domain: migrationDomain(config), onDeferred: (id) => deferred.push(id) }),
    ).toEqual([]);
    expect(deferred).toEqual([MIGRATION]);
    expect(snapshot(db)).toEqual(before);
    expect(isApplied(db)).toBe(false);
  }

  // A later boot with the real DOMAIN applies it.
  const config = loadConfig({ DATA_DIR: tmp, DOMAIN });
  expect(migrationDomain(config)).toBe(DOMAIN);
  expect(migrate(db, { domain: migrationDomain(config), log: () => {} })).toEqual([MIGRATION]);
  expect(isApplied(db)).toBe(true);
  expect(snapshot(db).conversations).toHaveLength(1);
});

test("migration 0036 sanity guard: a likely wrong DOMAIN deletes nothing and stays unapplied", async () => {
  const { db } = freshApp("hygiene-migration-guard");
  // Six consistent pointers under DOMAIN — all fail under a wrong domain.
  for (const peer of ["a", "b", "c", "d", "e", "f"]) {
    const cp = `${peer}@remote.example`;
    insertRawConversation(db, "alice", deriveDmId(`alice@${DOMAIN}`, cp), cp);
  }
  db.sqlite.query("DELETE FROM _migrations WHERE id = ?").run(MIGRATION);
  const before = snapshot(db);
  const reasons: string[] = [];
  expect(
    migrate(db, { domain: "wrong.example", onDeferred: (_id, why) => reasons.push(why) }),
  ).toEqual([]);
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toContain("6 of 6");
  expect(snapshot(db)).toEqual(before);
  expect(isApplied(db)).toBe(false);
  // The right domain finds nothing to delete.
  expect(migrate(db, { domain: DOMAIN, log: () => {} })).toEqual([MIGRATION]);
  expect(snapshot(db)).toEqual(before);
});

test("upsertDmPointer refuses a counterparty that does not derive the dmId", async () => {
  const { app, db } = freshApp("hygiene-upsert-guard");
  const alice = await registerUserWithKey(app, "alice");
  const dmId = deriveDmId(alice.actor, "carol@remote.example");
  expect(upsertDmPointer(db, alice.actor, dmId, "mallory@remote.example")).toBe(false);
  expect(upsertDmPointer(db, alice.actor, dmId, "not an actor")).toBe(false);
  expect(db.drizzle.select().from(dmConversations).all()).toEqual([]);
  expect(upsertDmPointer(db, alice.actor, dmId, "CAROL@remote.example")).toBe(true);
  expect(db.drizzle.select().from(dmConversations).all()[0]?.counterparty).toBe(
    "carol@remote.example",
  );
});

test("the counterparty of an inconsistent row is not a thread participant", async () => {
  const { app, db } = freshApp("hygiene-thread-participant");
  const alice = await registerUserWithKey(app, "alice");
  const bob = await registerUserWithKey(app, "bob");
  // alice's inbox holds a message from carol; a bogus row names bob / a remote
  // actor as the counterparty of that conversation.
  const dmId = deriveDmId(alice.actor, "carol@remote.example");
  db.sqlite
    .query(
      "INSERT INTO dm_messages (id, dm_id, owner, author, content, attachments, seq, created_at, edit_until) VALUES ('msg_c', ?, 'alice', 'carol@remote.example', ?, '[]', 1, ?, ?)",
    )
    .run(dmId, JSON.stringify({ text: "secret", mime: "text/plain" }), Date.now(), Date.now());
  insertRawConversation(db, "alice", dmId, bob.actor);

  // The counterparty branch (no own row for dmId): a remote viewer is refused…
  expect(isDmThreadParticipant(db, dmId, { actor: bob.actor }, DOMAIN)).toBe(false);
  db.sqlite
    .query("UPDATE dm_conversations SET counterparty = 'mallory@remote.example' WHERE dm_id = ?")
    .run(dmId);
  expect(isDmThreadParticipant(db, dmId, { actor: "mallory@remote.example" }, DOMAIN)).toBe(false);
  // …and so is a local one over HTTP (bob has no row of his own for dmId).
  db.sqlite
    .query("UPDATE dm_conversations SET counterparty = ? WHERE dm_id = ?")
    .run(bob.actor, dmId);
  const read = await signedRequest(app, bob, "GET", `/api/dms/${dmId}/messages`);
  expect(read.status).toBe(404);
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
