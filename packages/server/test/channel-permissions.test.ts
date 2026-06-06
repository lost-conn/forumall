/**
 * Per-channel permission tests (spec §5.2.1).
 *
 * Covers the channel `permissions` overrides added on top of group-level
 * permissions: the `view` read gate, per-kind `post:<type>` gating, the `react`
 * gate, and reply-qualification (`replyOnly` / `replyOnlyTo`).
 *
 * Authorization decisions are exercised two ways: directly via
 * {@link authorizeChannelPost} / {@link canViewChannel} (fast, exhaustive) and
 * end-to-end via `app.request` for the HTTP read gate + the channel
 * create/update round-trip (the `permissions` object persists + re-serializes).
 *
 * Argon2id cost is reduced (TEST-ONLY) so register stays fast.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  type Channel,
  type Group,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { groupMembers } from "../src/db/schema.ts";
import { authorizeChannelPost } from "../src/http/message-mutations.ts";
import { canViewChannel, getChannelRow } from "../src/provider/channels.ts";
import { createMessage } from "../src/provider/messages.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-chan-perms-"));
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
type Db = ReturnType<typeof freshApp>["db"];

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

function addMember(db: Db, groupId: string, signer: Signer, role: string): void {
  db.drizzle
    .insert(groupMembers)
    .values({ groupId, user: signer.actor, role, joinedAt: Date.now() })
    .run();
}

async function createChannel(
  app: App,
  owner: Signer,
  groupId: string,
  body: Record<string, unknown>,
): Promise<Channel> {
  const res = await signedRequest(app, owner, "POST", `/api/groups/${groupId}/channels`, body);
  expect(res.status).toBe(201);
  return (await res.json()) as Channel;
}

describe("per-channel permissions (§5.2.1)", () => {
  test("create/update round-trips the permissions object", async () => {
    const { app } = freshApp("roundtrip");
    const owner = await registerUserWithKey(app, "owner");
    const group = await createGroup(app, owner, { name: "G", tier: "group" });

    const created = await createChannel(app, owner, group.id, {
      type: "text",
      tier: "group",
      permissions: { "post:memo": ["admin"], view: ["member"] },
    });
    expect(created.permissions).toEqual({ "post:memo": ["admin"], view: ["member"] });

    // Re-fetch via list to confirm it persisted, not just echoed.
    const listRes = await signedRequest(app, owner, "GET", `/api/groups/${group.id}/channels`);
    expect(listRes.status).toBe(200);
    const channels = ((await listRes.json()) as { items: Channel[] }).items;
    const found = channels.find((c) => c.id === created.id);
    expect(found?.permissions).toEqual({ "post:memo": ["admin"], view: ["member"] });

    // PATCH with `{}` clears the overrides (channel reverts to group/tier).
    const patch = await signedRequest(
      app,
      owner,
      "PATCH",
      `/api/groups/${group.id}/channels/${created.id}`,
      { permissions: {} },
    );
    expect(patch.status).toBe(200);
    expect((await patch.json()).permissions).toBeUndefined();
  });

  test("post:<kind> override gates by kind, falling back to group post", async () => {
    const { app, db } = freshApp("postkind");
    const owner = await registerUserWithKey(app, "owner2");
    const member = await registerUserWithKey(app, "member2");
    const admin = await registerUserWithKey(app, "admin2");
    const group = await createGroup(app, owner, { name: "G", tier: "group" });
    addMember(db, group.id, member, "member");
    addMember(db, group.id, admin, "admin");

    const channel = await createChannel(app, owner, group.id, {
      type: "text",
      tier: "group",
      permissions: { "post:memo": ["admin"], "post:article": ["admin"] },
    });

    // Regular `message` falls back to group `post` (members may post).
    expect(
      authorizeChannelPost(db, group.id, channel.id, member.actor, "message", undefined),
    ).toBeNull();
    // `memo`/`article` require admin → member denied, admin allowed.
    const denied = authorizeChannelPost(db, group.id, channel.id, member.actor, "memo", undefined);
    expect(denied?.status).toBe(403);
    expect(
      authorizeChannelPost(db, group.id, channel.id, admin.actor, "memo", undefined),
    ).toBeNull();
    expect(
      authorizeChannelPost(db, group.id, channel.id, admin.actor, "article", undefined),
    ).toBeNull();
    // Owner is always allowed regardless of the override.
    expect(
      authorizeChannelPost(db, group.id, channel.id, owner.actor, "memo", undefined),
    ).toBeNull();

    // Non-member cannot post at all.
    const stranger = await registerUserWithKey(app, "stranger2");
    expect(
      authorizeChannelPost(db, group.id, channel.id, stranger.actor, "message", undefined)?.status,
    ).toBe(403);
  });

  test("reply qualification: replyOnly + replyOnlyTo", async () => {
    const { app, db, config } = freshApp("replyqual");
    const owner = await registerUserWithKey(app, "owner3");
    const member = await registerUserWithKey(app, "member3");
    const group = await createGroup(app, owner, { name: "G", tier: "group" });
    addMember(db, group.id, member, "member");

    const channel = await createChannel(app, owner, group.id, {
      type: "text",
      tier: "group",
      permissions: { replyOnly: ["member"], replyOnlyTo: ["memo"] },
    });

    // Seed a memo (by owner) and a regular message (by owner) to reply to.
    const memo = createMessage(db, config, {
      channelId: channel.id,
      groupId: group.id,
      author: owner.actor,
      type: "memo",
      content: { text: "announce", mime: "text/plain" },
    });
    const chat = createMessage(db, config, {
      channelId: channel.id,
      groupId: group.id,
      author: owner.actor,
      type: "message",
      content: { text: "hi", mime: "text/plain" },
    });

    // Member (reply-restricted) cannot post a top-level message.
    expect(
      authorizeChannelPost(db, group.id, channel.id, member.actor, "message", undefined)?.status,
    ).toBe(403);
    // Replying to a memo is allowed.
    expect(
      authorizeChannelPost(db, group.id, channel.id, member.actor, "message", {
        type: "reply",
        id: memo.message.id,
      }),
    ).toBeNull();
    // Replying to a non-memo (chat message) is denied by replyOnlyTo.
    expect(
      authorizeChannelPost(db, group.id, channel.id, member.actor, "message", {
        type: "reply",
        id: chat.message.id,
      })?.status,
    ).toBe(403);
    // Owner is never reply-restricted.
    expect(
      authorizeChannelPost(db, group.id, channel.id, owner.actor, "message", undefined),
    ).toBeNull();
    // A reply to a nonexistent message is a 400 (bad target), not a 403.
    expect(
      authorizeChannelPost(db, group.id, channel.id, member.actor, "message", {
        type: "reply",
        id: "msg_nope",
      })?.status,
    ).toBe(400);
  });

  test("view override restricts read access, overriding tier", async () => {
    const { app, db } = freshApp("viewoverride");
    const owner = await registerUserWithKey(app, "owner4");
    const member = await registerUserWithKey(app, "member4");
    const admin = await registerUserWithKey(app, "admin4");
    // public-tier group so tier alone would allow anyone.
    const group = await createGroup(app, owner, { name: "G", tier: "public" });
    addMember(db, group.id, member, "member");
    addMember(db, group.id, admin, "admin");

    const channel = await createChannel(app, owner, group.id, {
      type: "text",
      tier: "public",
      permissions: { view: ["admin"] },
    });
    const row = getChannelRow(db, channel.id);
    if (!row) throw new Error("channel row missing");

    // view:["admin"] → admin/owner see it; member + anonymous do not (despite public tier).
    expect(canViewChannel(db, row, owner.actor)).toBe(true);
    expect(canViewChannel(db, row, admin.actor)).toBe(true);
    expect(canViewChannel(db, row, member.actor)).toBe(false);
    expect(canViewChannel(db, row, null)).toBe(false);

    // HTTP history read reflects the same gate: member → 403, admin → 200.
    const memberRead = await signedRequest(
      app,
      member,
      "GET",
      `/api/groups/${group.id}/channels/${channel.id}/messages`,
    );
    expect(memberRead.status).toBe(403);
    const adminRead = await signedRequest(
      app,
      admin,
      "GET",
      `/api/groups/${group.id}/channels/${channel.id}/messages`,
    );
    expect(adminRead.status).toBe(200);
  });
});
