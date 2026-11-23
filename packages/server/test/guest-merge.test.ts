/**
 * Guest → EXISTING-account "merge" tests (Forumall extension over §4.8 / §4.1).
 *
 * The companion of the guest CLAIM. A signed-in guest supplies an EXISTING full
 * account's handle + password (a login-equivalent check) and has ALL of its
 * content/identity folded into that target actor, its device key re-bound to the
 * target (so the same keyId now signs as the target), and its `users` row
 * deleted. Unlike claim, every rewrite can collide with the target's own rows, so
 * we exercise BOTH the clean-transfer and conflict cases:
 *
 *  - group_members: a SHARED group G (role conflict → keep alice's role, drop the
 *    guest's) AND a group H where alice is NOT a member (clean transfer).
 *  - reactions: a DUPLICATE reaction (same message+key as alice's → dropped) and a
 *    UNIQUE one (transferred).
 *  - DMs: a thread with a third user (re-keyed to alice's dm_id + merged).
 *
 * Argon2id cost is reduced (TEST-ONLY) so register/merge stay fast.
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
import { and, eq } from "drizzle-orm";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  deviceKeys,
  dmConversations,
  dmMessages,
  dmReactions,
  groupMembers,
  messages,
  reactions,
  readMarkers,
  users,
} from "../src/db/schema.ts";
import { addDmReaction } from "../src/provider/dm-reactions.ts";
import { storeDmMessage, upsertDmPointer } from "../src/provider/dms.ts";
import { createMessage } from "../src/provider/messages.ts";
import { addReaction } from "../src/provider/reactions.ts";
import { setReadMarkers } from "../src/provider/read-markers.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-merge-"));
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

const PASSWORD = "correct-horse-battery";

async function registerUserWithKey(app: App, handle: string): Promise<Signer> {
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: PASSWORD }),
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

/** Provision a guest via a `grantsGuest` invite into `groupId` with `role`. */
async function provisionGuest(
  app: App,
  ownerSigner: Signer,
  groupId: string,
  role = "guest",
): Promise<Signer & { handle: string }> {
  const inviteRes = await signedRequest(
    app,
    ownerSigner,
    "POST",
    `/api/groups/${groupId}/invites`,
    {
      grantsGuest: true,
      role,
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
  return { keyId: body.key_id, privateKey, actor: body.actor, handle: body.profile.handle };
}

/** Have `signer` join `groupId` via a member invite minted by the owner. */
async function joinViaInvite(
  app: App,
  ownerSigner: Signer,
  joiner: Signer,
  groupId: string,
  role = "member",
): Promise<void> {
  const inviteRes = await signedRequest(
    app,
    ownerSigner,
    "POST",
    `/api/groups/${groupId}/invites`,
    {
      role,
    },
  );
  expect(inviteRes.status).toBe(201);
  const invite = (await inviteRes.json()) as { token: string };
  const redeem = await signedRequest(app, joiner, "POST", `/api/invites/${invite.token}/redeem`);
  expect(redeem.status).toBe(200);
}

// ---------------------------------------------------------------------------
// Happy path: conflict-aware identity merge
// ---------------------------------------------------------------------------

test("merge: folds the guest into an existing account with conflict resolution", async () => {
  const { app, config, db } = freshApp("merge-happy");

  // Target alice: a full account that owns + joins group G (her role = owner),
  // plus a third user carol for the DM thread.
  const alice = await registerUserWithKey(app, "alice");
  const carol = await registerUserWithKey(app, "carol");

  const groupG = await createGroup(app, alice, {
    name: "G",
    tier: "public",
    joinPolicy: "invite",
  });
  // A channel under G so the guest can author a message + so alice can react.
  const chRes = await signedRequest(app, alice, "POST", `/api/groups/${groupG.id}/channels`, {
    name: "general",
    tier: "group",
    type: "text",
  });
  expect(chRes.status).toBe(201);
  const channel = (await chRes.json()) as { id: string };

  // A SECOND group H that alice does NOT belong to (owned by carol) — the guest
  // will join it so the membership cleanly transfers.
  const groupH = await createGroup(app, carol, {
    name: "H",
    tier: "public",
    joinPolicy: "invite",
  });

  // The guest joins G (role conflict with alice) and H (clean transfer).
  const guest = await provisionGuest(app, alice, groupG.id, "guest");
  const oldHandle = guest.handle;
  const oldActor = guest.actor;
  await joinViaInvite(app, carol, guest, groupH.id, "member");

  // alice's role in G before the merge (her own membership — must be preserved).
  const aliceRoleBefore = db.drizzle
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupG.id), eq(groupMembers.user, alice.actor)))
    .all()[0]?.role;
  expect(aliceRoleBefore).toBe("owner");

  // The guest authors a channel message.
  const guestMsg = createMessage(db, config, {
    channelId: channel.id,
    groupId: groupG.id,
    author: oldActor,
    type: "message",
    content: { text: "hi from a guest", mime: "text/plain" },
  });
  // alice authors her own message (so we can set up a duplicate reaction).
  const aliceMsg = createMessage(db, config, {
    channelId: channel.id,
    groupId: groupG.id,
    author: alice.actor,
    type: "message",
    content: { text: "alice here", mime: "text/plain" },
  });

  // CONFLICT reaction: BOTH alice and the guest react to aliceMsg with "heart"
  // → on merge the guest's duplicate must be dropped (no unique violation).
  addReaction(db, {
    messageId: aliceMsg.message.id,
    channelId: channel.id,
    groupId: groupG.id,
    author: alice.actor,
    key: "heart",
  });
  addReaction(db, {
    messageId: aliceMsg.message.id,
    channelId: channel.id,
    groupId: groupG.id,
    author: oldActor,
    key: "heart",
  });
  // UNIQUE reaction: the guest reacts to its OWN message with "wave" → transfers.
  addReaction(db, {
    messageId: guestMsg.message.id,
    channelId: channel.id,
    groupId: groupG.id,
    author: oldActor,
    key: "wave",
    unicode: "👋",
  });

  // A DM thread between the guest and carol. carol sends the guest a DM (lands in
  // the guest's inbox); the guest sends carol a DM (lands in carol's inbox). Both
  // dmIds derive from (carol, guest-old) and must be re-keyed to (carol, alice).
  const dmGuestCarolBefore = deriveDmId(carol.actor, oldActor);
  storeDmMessage(db, config, {
    owner: oldHandle, // guest's inbox (received from carol)
    dmId: dmGuestCarolBefore,
    author: carol.actor,
    content: { text: "hey guest", mime: "text/plain" },
  });
  storeDmMessage(db, config, {
    owner: "carol", // carol's inbox (sent by the guest)
    dmId: dmGuestCarolBefore,
    author: oldActor,
    content: { text: "hi carol", mime: "text/plain" },
  });

  // -- Merge --------------------------------------------------------------
  const mergeRes = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(mergeRes.status).toBe(200);
  const merged = (await mergeRes.json()) as {
    actor: string;
    keyId: string;
    profile: UserProfile;
  };
  expect(merged.actor).toBe(alice.actor);
  expect(merged.keyId).toBe(guest.keyId); // caller's key unchanged
  expect(merged.profile.handle).toBe("alice");
  expect(merged.profile.guest).toBeUndefined();

  // -- The guest row is gone; alice's row is untouched --------------------
  expect(db.drizzle.select().from(users).where(eq(users.handle, oldHandle)).all()).toHaveLength(0);
  const aliceRow = db.drizzle.select().from(users).where(eq(users.handle, "alice")).all()[0];
  expect(aliceRow).toBeDefined();
  expect(aliceRow?.guest).toBe(false);
  expect(aliceRow?.passwordHash).not.toBeNull();
  // alice's display name is hers — the merge does NOT import the guest's.
  expect(aliceRow?.displayName ?? null).toBeNull();

  // -- The guest's device key now binds to alice (same keyId signs as alice) -
  const dk = db.drizzle.select().from(deviceKeys).where(eq(deviceKeys.keyId, guest.keyId)).all()[0];
  expect(dk?.userHandle).toBe("alice");
  // alice now has TWO device keys (her own + the guest's re-bound one).
  expect(
    db.drizzle.select().from(deviceKeys).where(eq(deviceKeys.userHandle, "alice")).all(),
  ).toHaveLength(2);

  // The SAME keyId now authenticates as alice.
  const newSigner: Signer = {
    keyId: guest.keyId,
    privateKey: guest.privateKey,
    actor: alice.actor,
  };
  const meRes = await signedRequest(app, newSigner, "GET", "/api/me");
  expect(meRes.status).toBe(200);
  expect(((await meRes.json()) as UserAccount).profile.handle).toBe("alice");
  // The OLD guest actor no longer authenticates (its key was re-bound).
  const oldSigner: Signer = { keyId: guest.keyId, privateKey: guest.privateKey, actor: oldActor };
  expect((await signedRequest(app, oldSigner, "GET", "/api/me")).status).toBe(401);

  // -- group_members: G keeps ONE alice row with HER role; H transfers ----
  const aliceInG = db.drizzle
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupG.id), eq(groupMembers.user, alice.actor)))
    .all();
  expect(aliceInG).toHaveLength(1);
  expect(aliceInG[0]?.role).toBe("owner"); // alice's own role kept (guest's dropped)
  // No leftover guest membership anywhere.
  expect(
    db.drizzle.select().from(groupMembers).where(eq(groupMembers.user, oldActor)).all(),
  ).toHaveLength(0);
  // H: alice is now a member with the guest's role.
  const aliceInH = db.drizzle
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupH.id), eq(groupMembers.user, alice.actor)))
    .all();
  expect(aliceInH).toHaveLength(1);
  expect(aliceInH[0]?.role).toBe("member");

  // -- messages.author → alice -------------------------------------------
  const msgRow = db.drizzle
    .select()
    .from(messages)
    .where(eq(messages.id, guestMsg.message.id))
    .all()[0];
  expect(msgRow?.author).toBe(alice.actor);

  // -- reactions: duplicate dropped, unique transferred -------------------
  // alice still has exactly ONE "heart" on her message (no duplicate row).
  const hearts = db.drizzle
    .select()
    .from(reactions)
    .where(and(eq(reactions.messageId, aliceMsg.message.id), eq(reactions.key, "heart")))
    .all();
  expect(hearts).toHaveLength(1);
  expect(hearts[0]?.author).toBe(alice.actor);
  // The unique "wave" transferred to alice.
  const waves = db.drizzle
    .select()
    .from(reactions)
    .where(and(eq(reactions.messageId, guestMsg.message.id), eq(reactions.key, "wave")))
    .all();
  expect(waves).toHaveLength(1);
  expect(waves[0]?.author).toBe(alice.actor);
  // No reaction still authored by the old guest actor.
  expect(
    db.drizzle.select().from(reactions).where(eq(reactions.author, oldActor)).all(),
  ).toHaveLength(0);

  // -- DM re-keying: the thread is now (carol, alice) ---------------------
  const dmGuestCarolAfter = deriveDmId(carol.actor, alice.actor);
  expect(dmGuestCarolAfter).not.toBe(dmGuestCarolBefore);
  // No DM rows still carry the old dmId.
  expect(
    db.drizzle.select().from(dmMessages).where(eq(dmMessages.dmId, dmGuestCarolBefore)).all(),
  ).toHaveLength(0);
  // The guest's received DM is now in alice's inbox with the new dmId.
  const aliceDmInbox = db.drizzle
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.owner, "alice"))
    .all();
  expect(aliceDmInbox).toHaveLength(1);
  expect(aliceDmInbox[0]?.dmId).toBe(dmGuestCarolAfter);
  expect(aliceDmInbox[0]?.author).toBe(carol.actor);
  // The guest's sent DM (in carol's inbox): author now alice, new dmId.
  const carolDmInbox = db.drizzle
    .select()
    .from(dmMessages)
    .where(eq(dmMessages.owner, "carol"))
    .all();
  expect(carolDmInbox).toHaveLength(1);
  expect(carolDmInbox[0]?.author).toBe(alice.actor);
  expect(carolDmInbox[0]?.dmId).toBe(dmGuestCarolAfter);
  // Conversation summaries re-keyed for both inboxes.
  const aliceConv = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.owner, "alice"))
    .all();
  expect(aliceConv).toHaveLength(1);
  expect(aliceConv[0]?.dmId).toBe(dmGuestCarolAfter);
  expect(aliceConv[0]?.counterparty).toBe(carol.actor);
  const carolConv = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.owner, "carol"))
    .all();
  expect(carolConv).toHaveLength(1);
  expect(carolConv[0]?.dmId).toBe(dmGuestCarolAfter);
  expect(carolConv[0]?.counterparty).toBe(alice.actor);
});

// ---------------------------------------------------------------------------
// DM conversation MERGE: the target already has a thread with the counterparty
// ---------------------------------------------------------------------------

test("merge: coalesces a DM conversation the target already has", async () => {
  const { app, config, db } = freshApp("merge-dm-coalesce");
  const alice = await registerUserWithKey(app, "alice");
  const carol = await registerUserWithKey(app, "carol");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);
  const oldActor = guest.actor;

  // alice ALREADY has a DM thread with carol (carol sent alice a message).
  const dmAliceCarol = deriveDmId(carol.actor, alice.actor);
  storeDmMessage(db, config, {
    owner: "alice",
    dmId: dmAliceCarol,
    author: carol.actor,
    content: { text: "to alice", mime: "text/plain" },
  });
  // The GUEST also has a DM thread with carol (carol sent the guest a message).
  const dmGuestCarol = deriveDmId(carol.actor, oldActor);
  storeDmMessage(db, config, {
    owner: guest.handle,
    dmId: dmGuestCarol,
    author: carol.actor,
    content: { text: "to guest", mime: "text/plain" },
  });

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(200);

  // After merge BOTH messages live in alice's inbox under the (carol, alice)
  // dm_id, and there is exactly ONE conversation summary (the duplicate merged).
  const aliceInbox = db.drizzle
    .select()
    .from(dmMessages)
    .where(and(eq(dmMessages.owner, "alice"), eq(dmMessages.dmId, dmAliceCarol)))
    .all();
  expect(aliceInbox).toHaveLength(2);
  const conv = db.drizzle
    .select()
    .from(dmConversations)
    .where(and(eq(dmConversations.owner, "alice"), eq(dmConversations.dmId, dmAliceCarol)))
    .all();
  expect(conv).toHaveLength(1);
});

/** A cached pointer preview (`Message`) with a fixed client `createdAt`. */
function sentPreview(id: string, author: string) {
  return {
    id,
    author,
    type: "message",
    content: { text: id, mime: "text/plain" },
    attachments: [],
    createdAt: "2026-01-01T00:00:00Z",
    metadata: [],
  } as unknown as Parameters<typeof upsertDmPointer>[4];
}

function conversationRow(db: ReturnType<typeof freshApp>["db"], owner: string, dmId: string) {
  const rows = db.drizzle
    .select()
    .from(dmConversations)
    .where(and(eq(dmConversations.owner, owner), eq(dmConversations.dmId, dmId)))
    .all();
  expect(rows).toHaveLength(1);
  const row = rows[0];
  const preview = JSON.parse(row?.lastSentMessage ?? "null") as {
    id: string;
    author: string;
  } | null;
  return { row, preview };
}

test("merge: a clashing re-keyed pointer yields — the target's preview is kept even if older", async () => {
  // §4.8.1: a re-keyed pointer that clashes with one already keyed by the new
  // dmId yields to the existing one, whatever the preview store times.
  const { app, db } = freshApp("merge-dm-preview-yield");
  const alice = await registerUserWithKey(app, "alice");
  const carol = await registerUserWithKey(app, "carol");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);
  const oldActor = guest.actor;

  const dmAliceCarol = deriveDmId(carol.actor, alice.actor);
  upsertDmPointer(
    db,
    alice.actor,
    dmAliceCarol,
    carol.actor,
    sentPreview("msg_alice", alice.actor),
  );
  upsertDmPointer(
    db,
    guest.actor,
    deriveDmId(carol.actor, oldActor),
    carol.actor,
    sentPreview("msg_guest", oldActor),
  );
  // The guest's preview was STORED later — it still yields.
  db.sqlite.query("UPDATE dm_conversations SET last_sent_at = 1000 WHERE owner = 'alice'").run();
  db.sqlite
    .query("UPDATE dm_conversations SET last_sent_at = 2000 WHERE owner = ?")
    .run(guest.handle);

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(200);

  const { row, preview } = conversationRow(db, "alice", dmAliceCarol);
  expect(row?.lastSentAt).toBe(1000);
  expect(preview?.id).toBe("msg_alice");
});

test("merge: a re-keyed preview fills a clashing row that has none (re-authored, with its time)", async () => {
  const { app, config, db } = freshApp("merge-dm-preview-fill");
  const alice = await registerUserWithKey(app, "alice");
  const carol = await registerUserWithKey(app, "carol");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);
  const oldActor = guest.actor;

  // alice's row for carol has no preview (only a received message).
  const dmAliceCarol = deriveDmId(carol.actor, alice.actor);
  storeDmMessage(db, config, {
    owner: "alice",
    dmId: dmAliceCarol,
    author: carol.actor,
    content: { text: "to alice", mime: "text/plain" },
  });
  upsertDmPointer(
    db,
    guest.actor,
    deriveDmId(carol.actor, oldActor),
    carol.actor,
    sentPreview("msg_guest", oldActor),
  );
  db.sqlite
    .query("UPDATE dm_conversations SET last_sent_at = 2000 WHERE owner = ?")
    .run(guest.handle);

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(200);

  const { row, preview } = conversationRow(db, "alice", dmAliceCarol);
  expect(row?.lastSentAt).toBe(2000);
  expect(preview?.id).toBe("msg_guest");
  expect(preview?.author).toBe(alice.actor);
});

test("merge: a third party's pointer to the guest keeps its preview and store time", async () => {
  const { app, db } = freshApp("merge-dm-preview-third-party");
  const alice = await registerUserWithKey(app, "alice");
  const carol = await registerUserWithKey(app, "carol");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);

  // carol's pointer to the guest, caching a message carol sent.
  upsertDmPointer(
    db,
    carol.actor,
    deriveDmId(carol.actor, guest.actor),
    guest.actor,
    sentPreview("msg_carol", carol.actor),
  );
  db.sqlite.query("UPDATE dm_conversations SET last_sent_at = 3000 WHERE owner = 'carol'").run();

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(200);

  const { row, preview } = conversationRow(db, "carol", deriveDmId(carol.actor, alice.actor));
  expect(row?.counterparty).toBe(alice.actor);
  expect(row?.lastSentAt).toBe(3000);
  expect(preview?.id).toBe("msg_carol");
  expect(preview?.author).toBe(carol.actor);
});

/** Every read marker row for `handle`, as a `scopeId → lastReadSeq` record. */
function markersOf(db: ReturnType<typeof freshApp>["db"], handle: string) {
  const rows = db.drizzle.select().from(readMarkers).where(eq(readMarkers.handle, handle)).all();
  return Object.fromEntries(rows.map((r) => [r.scopeId, r.lastReadSeq]));
}

test("merge: the guest↔target conversation is dropped entirely (no self-conversation)", async () => {
  // §4.8.1: a conversation between the guest and the target would become a
  // conversation with oneself and is dropped — messages, pointers, DM reactions
  // and read markers alike.
  const { app, config, db } = freshApp("merge-dm-drop-self");
  const alice = await registerUserWithKey(app, "alice");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);
  const dmGuestAlice = deriveDmId(guest.actor, alice.actor);
  const dmSelf = deriveDmId(alice.actor, alice.actor);

  // Each sends the other a DM (one row in each inbox + a conversation row each).
  const toAlice = storeDmMessage(db, config, {
    owner: "alice",
    dmId: dmGuestAlice,
    author: guest.actor,
    content: { text: "hi alice", mime: "text/plain" },
  });
  const toGuest = storeDmMessage(db, config, {
    owner: guest.handle,
    dmId: dmGuestAlice,
    author: alice.actor,
    content: { text: "hi guest", mime: "text/plain" },
  });
  addDmReaction(db, {
    dmId: dmGuestAlice,
    messageId: toAlice.message.id,
    author: alice.actor,
    key: "heart",
  });
  addDmReaction(db, {
    dmId: dmGuestAlice,
    messageId: toGuest.message.id,
    author: guest.actor,
    key: "heart",
  });
  setReadMarkers(db, "alice", [{ scopeId: dmGuestAlice, lastReadSeq: toAlice.seq }]);
  setReadMarkers(db, guest.handle, [{ scopeId: dmGuestAlice, lastReadSeq: toGuest.seq }]);

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(200);

  for (const dmId of [dmGuestAlice, dmSelf]) {
    expect(db.drizzle.select().from(dmMessages).where(eq(dmMessages.dmId, dmId)).all()).toEqual([]);
    expect(
      db.drizzle.select().from(dmConversations).where(eq(dmConversations.dmId, dmId)).all(),
    ).toEqual([]);
    expect(db.drizzle.select().from(dmReactions).where(eq(dmReactions.dmId, dmId)).all()).toEqual(
      [],
    );
    expect(
      db.drizzle.select().from(readMarkers).where(eq(readMarkers.scopeId, dmId)).all(),
    ).toEqual([]);
  }
  const list = await signedRequest(app, alice, "GET", "/api/me/dms");
  expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
});

test("merge: a third party with conversations with both ends with one conversation, pointer and marker", async () => {
  // §4.8.1: for ANY user whose records are re-keyed, the re-keyed pointer yields
  // to the existing one and of two clashing markers the further-forward is kept.
  const { app, config, db } = freshApp("merge-dm-third-party-clash");
  const alice = await registerUserWithKey(app, "alice");
  const carol = await registerUserWithKey(app, "carol");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);
  const dmCarolAlice = deriveDmId(carol.actor, alice.actor);
  const dmCarolGuest = deriveDmId(carol.actor, guest.actor);

  // carol DMed both: her pointers (with previews) + their inbox copies.
  const toAlice = storeDmMessage(db, config, {
    owner: "alice",
    dmId: dmCarolAlice,
    author: carol.actor,
    content: { text: "to alice", mime: "text/plain" },
  });
  const toGuest = storeDmMessage(db, config, {
    owner: guest.handle,
    dmId: dmCarolGuest,
    author: carol.actor,
    content: { text: "to guest", mime: "text/plain" },
  });
  upsertDmPointer(
    db,
    carol.actor,
    dmCarolAlice,
    alice.actor,
    sentPreview("msg_to_alice", carol.actor),
  );
  upsertDmPointer(
    db,
    carol.actor,
    dmCarolGuest,
    guest.actor,
    sentPreview("msg_to_guest", carol.actor),
  );
  // carol's marker on the guest conversation is further forward than on alice's;
  // alice's own marker is further forward than the guest's.
  setReadMarkers(db, "carol", [
    { scopeId: dmCarolAlice, lastReadSeq: 5 },
    { scopeId: dmCarolGuest, lastReadSeq: 9 },
  ]);
  setReadMarkers(db, "alice", [{ scopeId: dmCarolAlice, lastReadSeq: toGuest.seq + 10 }]);
  setReadMarkers(db, guest.handle, [{ scopeId: dmCarolGuest, lastReadSeq: toGuest.seq }]);

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(200);

  // carol: ONE conversation (the existing pointer wins) and ONE marker (9).
  const carolConvs = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.owner, "carol"))
    .all();
  expect(carolConvs.map((r) => r.dmId)).toEqual([dmCarolAlice]);
  expect(carolConvs[0]?.counterparty).toBe(alice.actor);
  expect(JSON.parse(carolConvs[0]?.lastSentMessage ?? "null")?.id).toBe("msg_to_alice");
  expect(markersOf(db, "carol")).toEqual({ [dmCarolAlice]: 9 });

  // alice: one conversation with carol holding both inbox messages; her own
  // further-forward marker kept.
  const aliceConvs = db.drizzle
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.owner, "alice"))
    .all();
  expect(aliceConvs.map((r) => r.dmId)).toEqual([dmCarolAlice]);
  const aliceInbox = db.drizzle
    .select({ id: dmMessages.id })
    .from(dmMessages)
    .where(and(eq(dmMessages.owner, "alice"), eq(dmMessages.dmId, dmCarolAlice)))
    .all()
    .map((r) => r.id)
    .sort();
  expect(aliceInbox).toEqual([toAlice.message.id, toGuest.message.id].sort());
  expect(markersOf(db, "alice")).toEqual({ [dmCarolAlice]: toGuest.seq + 10 });
  expect(markersOf(db, guest.handle)).toEqual({});
});

test("merge: a moved message whose idempotency key collides survives with clientMessageId cleared", async () => {
  // §4.8.1: re-keyed messages are never dropped — a colliding
  // (author, channelId|dmId, clientMessageId) has the moved row's key cleared.
  const { app, config, db } = freshApp("merge-client-msg-collision");
  const alice = await registerUserWithKey(app, "alice");
  const carol = await registerUserWithKey(app, "carol");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const chRes = await signedRequest(app, alice, "POST", `/api/groups/${group.id}/channels`, {
    name: "general",
    tier: "group",
    type: "text",
  });
  expect(chRes.status).toBe(201);
  const channel = (await chRes.json()) as { id: string };
  const guest = await provisionGuest(app, alice, group.id);

  // Channel: alice and the guest used the same clientMessageId in one channel.
  const aliceMsg = createMessage(db, config, {
    channelId: channel.id,
    groupId: group.id,
    author: alice.actor,
    type: "message",
    content: { text: "alice", mime: "text/plain" },
    clientMessageId: "cm_1",
  });
  const guestMsg = createMessage(db, config, {
    channelId: channel.id,
    groupId: group.id,
    author: guest.actor,
    type: "message",
    content: { text: "guest", mime: "text/plain" },
    clientMessageId: "cm_1",
  });
  // DM (received): carol sent alice and the guest the same clientMessageId.
  const dmCarolAlice = deriveDmId(carol.actor, alice.actor);
  const carolToAlice = storeDmMessage(db, config, {
    owner: "alice",
    dmId: dmCarolAlice,
    author: carol.actor,
    content: { text: "to alice", mime: "text/plain" },
    clientMessageId: "dm_1",
  });
  const carolToGuest = storeDmMessage(db, config, {
    owner: guest.handle,
    dmId: deriveDmId(carol.actor, guest.actor),
    author: carol.actor,
    content: { text: "to guest", mime: "text/plain" },
    clientMessageId: "dm_1",
  });
  // DM (sent): alice and the guest sent carol the same clientMessageId.
  const aliceToCarol = storeDmMessage(db, config, {
    owner: "carol",
    dmId: dmCarolAlice,
    author: alice.actor,
    content: { text: "from alice", mime: "text/plain" },
    clientMessageId: "dm_2",
  });
  const guestToCarol = storeDmMessage(db, config, {
    owner: "carol",
    dmId: deriveDmId(carol.actor, guest.actor),
    author: guest.actor,
    content: { text: "from guest", mime: "text/plain" },
    clientMessageId: "dm_2",
  });

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(200);

  const ch = (id: string) => db.drizzle.select().from(messages).where(eq(messages.id, id)).all()[0];
  expect(ch(aliceMsg.message.id)?.clientMessageId).toBe("cm_1");
  expect(ch(guestMsg.message.id)?.author).toBe(alice.actor);
  expect(ch(guestMsg.message.id)?.clientMessageId).toBeNull();

  const dm = (id: string) =>
    db.drizzle.select().from(dmMessages).where(eq(dmMessages.id, id)).all()[0];
  expect(dm(carolToAlice.message.id)?.clientMessageId).toBe("dm_1");
  expect(dm(carolToGuest.message.id)).toMatchObject({
    owner: "alice",
    dmId: dmCarolAlice,
    clientMessageId: null,
  });
  expect(dm(aliceToCarol.message.id)?.clientMessageId).toBe("dm_2");
  expect(dm(guestToCarol.message.id)).toMatchObject({
    author: alice.actor,
    dmId: dmCarolAlice,
    clientMessageId: null,
  });
});

/** Write raw `dm_conversations` + `read_markers` rows, bypassing every write-path check. */
function insertRawPointer(
  db: ReturnType<typeof freshApp>["db"],
  owner: string,
  dmId: string,
  counterparty: string,
  markerSeq: number,
  lastSentMessage: string | null = null,
  lastMessageSeq = 0,
) {
  db.sqlite
    .query(
      "INSERT INTO dm_conversations (owner, dm_id, counterparty, updated_at, last_message_seq, last_sent_message, last_sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      owner,
      dmId,
      counterparty,
      Date.now(),
      lastMessageSeq,
      lastSentMessage,
      lastSentMessage ? 1 : null,
    );
  db.sqlite
    .query(
      "INSERT INTO read_markers (handle, scope_id, last_read_seq, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(owner, dmId, markerSeq, Date.now());
}

test("merge: inconsistent (ignored) rows are never revived — pure pointers deleted, rows with messages kept", async () => {
  // §7.4: a pointer whose counterparty does not derive its dmId is ignored; a
  // merge must not re-derive it into a valid conversation.
  const { app, db } = freshApp("merge-inconsistent-rows");
  const alice = await registerUserWithKey(app, "alice");
  const carol = await registerUserWithKey(app, "carol");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);
  // A: the guest's row names alice but its dmId is not guest↔alice — re-keying
  // would make it a listed alice↔alice self-conversation.
  const dmX = deriveDmId(guest.actor, "zed@remote.example");
  insertRawPointer(db, guest.handle, dmX, alice.actor, 11);
  // B: carol's bogus row names the guest — re-keying would make it a valid
  // carol↔alice conversation carrying a stale preview and another thread's marker.
  const dmBogus = deriveDmId(carol.actor, "zed@remote.example");
  insertRawPointer(
    db,
    "carol",
    dmBogus,
    guest.actor,
    50,
    JSON.stringify(sentPreview("msg_stale", carol.actor)),
  );

  // Inconsistent rows that hold received messages are KEPT (never deleted, never
  // re-derived): the guest's moves to alice with its dmId; carol's is untouched.
  const dmKeepGuest = deriveDmId(guest.actor, "yan@remote.example");
  insertRawPointer(db, guest.handle, dmKeepGuest, "erin@remote.example", 4, null, 4);
  const dmKeepCarol = deriveDmId(carol.actor, "yan@remote.example");
  insertRawPointer(db, "carol", dmKeepCarol, guest.actor, 6, null, 6);

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(200);

  const convs = db.drizzle
    .select({ owner: dmConversations.owner, dmId: dmConversations.dmId })
    .from(dmConversations)
    .all()
    .sort((x, y) => x.owner.localeCompare(y.owner));
  expect(convs).toEqual([
    { owner: "alice", dmId: dmKeepGuest },
    { owner: "carol", dmId: dmKeepCarol },
  ]);
  const markers = db.drizzle
    .select({ handle: readMarkers.handle, scopeId: readMarkers.scopeId })
    .from(readMarkers)
    .all()
    .sort((x, y) => x.handle.localeCompare(y.handle));
  expect(markers).toEqual([
    { handle: "alice", scopeId: dmKeepGuest },
    { handle: "carol", scopeId: dmKeepCarol },
  ]);
  for (const who of [alice, carol]) {
    const list = await signedRequest(app, who, "GET", "/api/me/dms");
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

test("merge: wrong password → 401", async () => {
  const { app } = freshApp("merge-badpw");
  const alice = await registerUserWithKey(app, "alice");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "alice",
    password: "wrong-password",
  });
  expect(res.status).toBe(401);
  // The guest is untouched (still a guest, still authenticates as itself).
  const me = await signedRequest(app, guest, "GET", "/api/me");
  expect(me.status).toBe(200);
  expect(((await me.json()) as UserAccount).profile.guest).toBe(true);
});

test("merge: non-existent target handle → 401", async () => {
  const { app } = freshApp("merge-nouser");
  const alice = await registerUserWithKey(app, "alice");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guest = await provisionGuest(app, alice, group.id);

  const res = await signedRequest(app, guest, "POST", "/api/me/merge", {
    handle: "nobody",
    password: PASSWORD,
  });
  expect(res.status).toBe(401);
});

test("merge: caller is already a full account → 409", async () => {
  const { app } = freshApp("merge-full");
  const alice = await registerUserWithKey(app, "alice");
  const bob = await registerUserWithKey(app, "bob");

  const res = await signedRequest(app, bob, "POST", "/api/me/merge", {
    handle: "alice",
    password: PASSWORD,
  });
  expect(res.status).toBe(409);
});

test("merge: into another GUEST (passwordless) → 401", async () => {
  const { app } = freshApp("merge-into-guest");
  const alice = await registerUserWithKey(app, "alice");
  const group = await createGroup(app, alice, { name: "G", tier: "public", joinPolicy: "invite" });
  const guestA = await provisionGuest(app, alice, group.id);
  const guestB = await provisionGuest(app, alice, group.id);

  // guestA tries to merge into guestB (a passwordless guest) → uniform 401.
  const res = await signedRequest(app, guestA, "POST", "/api/me/merge", {
    handle: guestB.handle,
    password: PASSWORD,
  });
  expect(res.status).toBe(401);
  // guestA is untouched — still a guest, still authenticates as itself.
  const me = await signedRequest(app, guestA, "GET", "/api/me");
  expect(me.status).toBe(200);
  expect(((await me.json()) as UserAccount).profile.guest).toBe(true);
});
