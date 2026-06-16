/**
 * Guest → full-account "claim" tests (Forumall extension over §4.8 / §4.1).
 *
 * Exercises the full identity migration: a guest (minted via a `grantsGuest`
 * invite) with a device key + group membership + an authored channel message +
 * a reaction + a DM claims a new handle and password. We assert the guest's
 * identity is rewritten EVERYWHERE (users PK, device key binding, membership,
 * message/reaction authors, DM re-keying) and that the SAME device keypair keeps
 * signing — now as the new actor — and that password login now works.
 *
 * Argon2id cost is reduced (TEST-ONLY) so register/claim stay fast.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Group,
  type UserAccount,
  type UserProfile,
  deriveDmId,
  generateKeyPair,
  sign,
} from "@forumall/shared";
import { eq } from "drizzle-orm";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  deviceKeys,
  dmConversations,
  dmMessages,
  groupMembers,
  messages,
  reactions,
  users,
} from "../src/db/schema.ts";
import { storeDmMessage } from "../src/provider/dms.ts";
import { createMessage } from "../src/provider/messages.ts";
import { addReaction } from "../src/provider/reactions.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-claim-"));
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
  const app = createApp(config, { db });
  return { app, config, db };
}

type App = ReturnType<typeof freshApp>["app"];

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
}

async function registerUserWithKey(app: App, handle: string): Promise<Signer> {
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

async function createGroup(
  app: App,
  signer: Signer,
  body: Record<string, unknown>,
): Promise<Group> {
  const res = await signedRequest(app, signer, "POST", "/api/groups", body);
  expect(res.status).toBe(201);
  return (await res.json()) as Group;
}

/**
 * Provision a guest via a `grantsGuest` invite (mirrors invites.test.ts). Returns
 * a {@link Signer} for the guest (its own device keypair) + its bare handle.
 */
async function provisionGuest(
  app: App,
  ownerSigner: Signer,
  groupId: string,
): Promise<Signer & { handle: string }> {
  const inviteRes = await signedRequest(
    app,
    ownerSigner,
    "POST",
    `/api/groups/${groupId}/invites`,
    {
      grantsGuest: true,
      role: "guest",
    },
  );
  expect(inviteRes.status).toBe(201);
  const invite = (await inviteRes.json()) as { token: string };

  const { publicKey, privateKey } = generateKeyPair();
  const res = await app.request(`/api/invites/${invite.token}/guest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "Guest Ada",
      public_key: publicKey,
      algorithm: "Ed25519",
      device_name: "Chrome",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { actor: string; key_id: string; profile: UserProfile };
  return {
    keyId: body.key_id,
    privateKey,
    actor: body.actor,
    handle: body.profile.handle,
  };
}

// ---------------------------------------------------------------------------
// Happy path: full identity migration
// ---------------------------------------------------------------------------

test("claim: full identity migration rewrites everything + keypair survives", async () => {
  const { app, config, db } = freshApp("claim-happy");
  const alice = await registerUserWithKey(app, "alice");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });

  // A channel under the group so the guest can author a message.
  const chRes = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/channels`, {
    name: "general",
    tier: "group",
    type: "text",
  });
  expect(chRes.status).toBe(201);
  const channel = (await chRes.json()) as { id: string };

  const guest = await provisionGuest(app, alice, group.id);
  const oldHandle = guest.handle;
  const oldActor = guest.actor;
  expect(oldActor).toBe(`${oldHandle}@${DOMAIN}`);

  // The guest authors a channel message + a reaction (identity references).
  const msg = createMessage(db, config, {
    channelId: channel.id,
    groupId: group.id,
    author: oldActor,
    type: "message",
    content: { text: "hi from a guest", mime: "text/plain" },
  });
  addReaction(db, {
    messageId: msg.message.id,
    channelId: channel.id,
    groupId: group.id,
    author: oldActor,
    key: "wave",
    unicode: "👋",
  });

  // A DM: alice sends the guest a DM (lands in the guest's inbox), and the guest
  // sends alice a DM (lands in alice's inbox). Both dmIds are derived from the
  // (alice, guest-old) pair and must be re-derived after claim.
  const dmIdBefore = deriveDmId(alice.actor, oldActor);
  storeDmMessage(db, config, {
    owner: oldHandle, // guest's inbox (received from alice)
    dmId: dmIdBefore,
    author: alice.actor,
    content: { text: "welcome", mime: "text/plain" },
  });
  storeDmMessage(db, config, {
    owner: "alice", // alice's inbox (sent by the guest)
    dmId: dmIdBefore,
    author: oldActor,
    content: { text: "thanks!", mime: "text/plain" },
  });

  // -- Claim --------------------------------------------------------------
  const claimRes = await signedRequest(app, guest, "POST", "/api/me/claim", {
    handle: "ada",
    password: "super-secret-pw",
    displayName: "Ada Lovelace",
  });
  expect(claimRes.status).toBe(200);
  const claim = (await claimRes.json()) as {
    actor: string;
    keyId: string;
    profile: UserProfile;
  };
  const newActor = `ada@${DOMAIN}`;
  expect(claim.actor).toBe(newActor);
  expect(claim.keyId).toBe(guest.keyId); // unchanged — same key
  expect(claim.profile.handle).toBe("ada");
  expect(claim.profile.guest).toBeUndefined(); // no longer a guest
  expect(claim.profile.displayName).toBe("Ada Lovelace");

  // -- Assert the DB was rewritten ----------------------------------------
  // Old guest row gone; new row present, full account.
  expect(db.drizzle.select().from(users).where(eq(users.handle, oldHandle)).all()).toHaveLength(0);
  const newRow = db.drizzle.select().from(users).where(eq(users.handle, "ada")).all()[0];
  expect(newRow).toBeDefined();
  expect(newRow?.passwordHash).not.toBeNull();
  expect(newRow?.guest).toBe(false);
  expect(newRow?.expiresAt).toBeNull();
  expect(newRow?.displayName).toBe("Ada Lovelace");

  // device_keys.user_handle migrated (the SAME keyId now binds to ada).
  const dk = db.drizzle.select().from(deviceKeys).where(eq(deviceKeys.keyId, guest.keyId)).all()[0];
  expect(dk?.userHandle).toBe("ada");

  // group_members.user → new actor.
  const gm = db.drizzle.select().from(groupMembers).where(eq(groupMembers.user, newActor)).all();
  expect(gm).toHaveLength(1);
  expect(
    db.drizzle.select().from(groupMembers).where(eq(groupMembers.user, oldActor)).all(),
  ).toHaveLength(0);

  // messages.author → new actor.
  const msgRow = db.drizzle.select().from(messages).where(eq(messages.id, msg.message.id)).all()[0];
  expect(msgRow?.author).toBe(newActor);

  // reactions.author → new actor.
  const rx = db.drizzle.select().from(reactions).where(eq(reactions.author, newActor)).all();
  expect(rx).toHaveLength(1);

  // -- DM re-keying -------------------------------------------------------
  const dmIdAfter = deriveDmId(alice.actor, newActor);
  expect(dmIdAfter).not.toBe(dmIdBefore);

  // No dm_messages still carry the old dmId or old actor/owner.
  const staleDm = db.drizzle.select().from(dmMessages).where(eq(dmMessages.dmId, dmIdBefore)).all();
  expect(staleDm).toHaveLength(0);

  // The guest's received DM: now owned by ada, new dmId.
  const adaInbox = db.drizzle.select().from(dmMessages).where(eq(dmMessages.owner, "ada")).all();
  expect(adaInbox).toHaveLength(1);
  expect(adaInbox[0]?.dmId).toBe(dmIdAfter);
  expect(adaInbox[0]?.author).toBe(alice.actor);

  // The guest's sent DM (in alice's inbox): author now newActor, new dmId.
  const aliceInbox = db.drizzle
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.owner, "alice"))
    .all();
  expect(aliceInbox).toHaveLength(1);
  expect(aliceInbox[0]?.author).toBe(newActor);
  expect(aliceInbox[0]?.dmId).toBe(dmIdAfter);

  // dm_conversations re-keyed for both inboxes.
  const adaConv = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.owner, "ada"))
    .all();
  expect(adaConv).toHaveLength(1);
  expect(adaConv[0]?.dmId).toBe(dmIdAfter);
  const aliceConv = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.owner, "alice"))
    .all();
  expect(aliceConv).toHaveLength(1);
  expect(aliceConv[0]?.dmId).toBe(dmIdAfter);
  expect(aliceConv[0]?.counterparty).toBe(newActor);

  // -- The keypair migration works: sign as the NEW actor with the SAME key -
  const newSigner: Signer = { keyId: guest.keyId, privateKey: guest.privateKey, actor: newActor };
  const meRes = await signedRequest(app, newSigner, "GET", "/api/me");
  expect(meRes.status).toBe(200);
  const me = (await meRes.json()) as UserAccount;
  expect(me.profile.handle).toBe("ada");
  expect(me.profile.guest).toBeUndefined();

  // The OLD actor no longer authenticates (its device key was re-bound).
  const oldSigner: Signer = { keyId: guest.keyId, privateKey: guest.privateKey, actor: oldActor };
  const meOld = await signedRequest(app, oldSigner, "GET", "/api/me");
  expect(meOld.status).toBe(401);

  // -- Password login now works -------------------------------------------
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "ada", password: "super-secret-pw" }),
  });
  expect(login.status).toBe(200);
  const loginBody = (await login.json()) as AuthBootstrapResponse;
  expect(typeof loginBody.bootstrap_token).toBe("string");
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

test("claim: a full account claiming → 409", async () => {
  const { app } = freshApp("claim-full");
  const alice = await registerUserWithKey(app, "alice");
  const res = await signedRequest(app, alice, "POST", "/api/me/claim", {
    handle: "alice2",
    password: "super-secret-pw",
  });
  expect(res.status).toBe(409);
});

test("claim: taken handle → 409", async () => {
  const { app } = freshApp("claim-taken");
  const alice = await registerUserWithKey(app, "alice");
  await registerUserWithKey(app, "taken");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);

  const res = await signedRequest(app, guest, "POST", "/api/me/claim", {
    handle: "taken",
    password: "super-secret-pw",
  });
  expect(res.status).toBe(409);
});

test("claim: invalid handle → 400; reserved guest_ prefix → 400", async () => {
  const { app } = freshApp("claim-invalid");
  const alice = await registerUserWithKey(app, "alice");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);

  // Uppercase / illegal chars rejected.
  const bad = await signedRequest(app, guest, "POST", "/api/me/claim", {
    handle: "Ada!",
    password: "super-secret-pw",
  });
  expect(bad.status).toBe(400);

  // The reserved guest_ prefix is rejected (must not masquerade as a guest).
  const reserved = await signedRequest(app, guest, "POST", "/api/me/claim", {
    handle: "guest_evil",
    password: "super-secret-pw",
  });
  expect(reserved.status).toBe(400);

  // The account is still a guest (no partial mutation).
  const me = await signedRequest(app, guest, "GET", "/api/me");
  expect(me.status).toBe(200);
  expect(((await me.json()) as UserAccount).profile.guest).toBe(true);
});

// ---------------------------------------------------------------------------
// Unit: DM re-keying with multiple counterparties
// ---------------------------------------------------------------------------

test("claim: DM re-keying handles a self-DM correctly", async () => {
  const { app, config, db } = freshApp("claim-selfdm");
  const alice = await registerUserWithKey(app, "alice");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);
  const oldActor = guest.actor;

  // A self-DM: guest as both owner and author.
  const selfDmBefore = deriveDmId(oldActor, oldActor);
  storeDmMessage(db, config, {
    owner: guest.handle,
    dmId: selfDmBefore,
    author: oldActor,
    content: { text: "note to self", mime: "text/plain" },
  });

  const res = await signedRequest(app, guest, "POST", "/api/me/claim", {
    handle: "ada",
    password: "super-secret-pw",
  });
  expect(res.status).toBe(200);

  const newActor = `ada@${DOMAIN}`;
  const selfDmAfter = deriveDmId(newActor, newActor);
  const rows = db.drizzle.select().from(dmMessages).where(eq(dmMessages.owner, "ada")).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.dmId).toBe(selfDmAfter);
  expect(rows[0]?.author).toBe(newActor);
  // The old self-DM id is fully gone.
  expect(
    db.drizzle.select().from(dmMessages).where(eq(dmMessages.dmId, selfDmBefore)).all(),
  ).toHaveLength(0);
});
