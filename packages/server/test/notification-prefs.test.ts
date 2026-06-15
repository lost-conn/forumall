/**
 * Per-channel / per-group notification preferences (a provider-LOCAL extension).
 *
 * Covers:
 *  - Effective-mode resolution: channel pref → group pref → default `mentions`.
 *  - `none` mutes a mention (and a channel `none` overrides a group `all`).
 *  - `all` fans a `message` notification to opted-in LOCAL members, deduped vs a
 *    mention, author-excluded, and not to members on the default `mentions`.
 *  - The signed `/api/me/notification-settings` routes (GET/PUT/DELETE) validate
 *    input and round-trip a preference.
 *
 * Detection is exercised directly via `notifyForChannelMessage` (the provider
 * helper the WS create path calls), plus the HTTP routes via `app.request`.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthBootstrapResponse, generateKeyPair, sign } from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { type Db, openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { addMember } from "../src/provider/membership.ts";
import { createMessage } from "../src/provider/messages.ts";
import { getEffectiveMode, listPrefs, setPref } from "../src/provider/notification-prefs.ts";
import { listNotifications, notifyForChannelMessage } from "../src/provider/notifications-feed.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-notifpref-"));
});

interface Booted {
  app: ReturnType<typeof createApp>;
  db: Db;
  config: Config;
}

let counter = 0;
function boot(): Booted {
  const name = `npf-${counter++}`;
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
  return { app, db, config };
}

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.sqlite.close();
});

interface Signer {
  keyId: string;
  privateKey: string;
  actor: string;
  handle: string;
}

async function registerUser(b: Booted, handle: string): Promise<Signer> {
  const reg = await b.app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const res = await b.app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, actor: `${handle}@${DOMAIN}`, handle };
}

function signedReq(
  b: Booted,
  signer: Signer,
  method: string,
  fullPath: string,
  bodyObj?: unknown,
): Promise<Response> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const q = fullPath.indexOf("?");
  const path = q === -1 ? fullPath : fullPath.slice(0, q);
  const query = q === -1 ? undefined : fullPath.slice(q + 1);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    path,
    ...(query !== undefined ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  return b.app.request(fullPath, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

function post(
  b: Booted,
  groupId: string,
  channelId: string,
  author: string,
  text: string,
  replyTo?: string,
): string {
  return createMessage(b.db, b.config, {
    groupId,
    channelId,
    author,
    type: "message",
    content: { text, mime: "text/plain" },
    ...(replyTo ? { reference: { type: "reply", id: replyTo } } : {}),
  }).message.id;
}

// ---------------------------------------------------------------------------
// Effective-mode resolution
// ---------------------------------------------------------------------------

describe("getEffectiveMode", () => {
  test("default is mentions; channel overrides group", () => {
    const b = boot();
    dbs.push(b.db);
    const chn = "chn_x";
    const grp = "grp_x";
    expect(getEffectiveMode(b.db, "alice", chn, grp)).toBe("mentions");

    setPref(b.db, "alice", "group", grp, "all");
    expect(getEffectiveMode(b.db, "alice", chn, grp)).toBe("all");

    setPref(b.db, "alice", "channel", chn, "none");
    // channel pref wins over the group pref
    expect(getEffectiveMode(b.db, "alice", chn, grp)).toBe("none");
  });

  test("setPref is an upsert (idempotent on the unique index)", () => {
    const b = boot();
    dbs.push(b.db);
    setPref(b.db, "alice", "group", "grp_y", "all");
    setPref(b.db, "alice", "group", "grp_y", "none");
    const prefs = listPrefs(b.db, "alice");
    expect(prefs).toHaveLength(1);
    expect(prefs[0]?.mode).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// none mutes / all fans out
// ---------------------------------------------------------------------------

describe("notifyForChannelMessage honors notification preferences", () => {
  test("a channel `none` suppresses the mention notification", async () => {
    const b = boot();
    dbs.push(b.db);
    await registerUser(b, "alice");
    await registerUser(b, "bob");
    const grp = "grp_m";
    const chn = "chn_m";
    addMember(b.db, grp, `alice@${DOMAIN}`, "owner");
    addMember(b.db, grp, `bob@${DOMAIN}`, "member");

    // bob mutes the channel.
    setPref(b.db, "bob", "channel", chn, "none");

    const msgId = post(b, grp, chn, `alice@${DOMAIN}`, "hey @bob look");
    const created = notifyForChannelMessage(b.db, {
      text: "hey @bob look",
      author: `alice@${DOMAIN}`,
      sourceMessageId: msgId,
      channelId: chn,
      groupId: grp,
      localDomain: DOMAIN,
    });
    // No notification for the muted recipient.
    expect(created).toHaveLength(0);
    expect(listNotifications(b.db, "bob").items).toHaveLength(0);
  });

  test("`all` fans a `message` notification to opted-in members, author excluded, deduped vs mention", async () => {
    const b = boot();
    dbs.push(b.db);
    await registerUser(b, "alice");
    await registerUser(b, "bob");
    await registerUser(b, "carol");
    const grp = "grp_a";
    const chn = "chn_a";
    addMember(b.db, grp, `alice@${DOMAIN}`, "owner");
    addMember(b.db, grp, `bob@${DOMAIN}`, "member");
    addMember(b.db, grp, `carol@${DOMAIN}`, "member");

    // bob opts into all; carol stays on the default (mentions); alice is author.
    setPref(b.db, "bob", "group", grp, "all");
    setPref(b.db, "alice", "channel", chn, "all"); // author, must still be excluded

    const msgId = post(b, grp, chn, `alice@${DOMAIN}`, "general chatter, no mentions");
    const created = notifyForChannelMessage(b.db, {
      text: "general chatter, no mentions",
      author: `alice@${DOMAIN}`,
      sourceMessageId: msgId,
      channelId: chn,
      groupId: grp,
      localDomain: DOMAIN,
    });

    // Only bob (all) gets a `message` row; carol (mentions, no mention) gets none;
    // alice (author) excluded despite her own `all`.
    expect(created.map((c) => c.recipient).sort()).toEqual(["bob"]);
    expect(created[0]?.type).toBe("message");
    expect(listNotifications(b.db, "bob").items[0]?.type).toBe("message");
    expect(listNotifications(b.db, "carol").items).toHaveLength(0);
    expect(listNotifications(b.db, "alice").items).toHaveLength(0);

    // Dedup: a SECOND message that BOTH mentions bob AND is `all` for him → one
    // `mention` row, not also a `message` row.
    const msg2 = post(b, grp, chn, `carol@${DOMAIN}`, "ping @bob");
    const created2 = notifyForChannelMessage(b.db, {
      text: "ping @bob",
      author: `carol@${DOMAIN}`,
      sourceMessageId: msg2,
      channelId: chn,
      groupId: grp,
      localDomain: DOMAIN,
    });
    const bobRows = created2.filter((c) => c.recipient === "bob");
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]?.type).toBe("mention");
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

describe("/api/me/notification-settings routes", () => {
  test("PUT upserts + GET lists + DELETE clears; validation rejects bad input", async () => {
    const b = boot();
    dbs.push(b.db);
    const alice = await registerUser(b, "alice");

    // PUT a valid channel pref.
    const put = await signedReq(b, alice, "PUT", "/api/me/notification-settings", {
      scopeType: "channel",
      scopeId: "chn_abc",
      mode: "all",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      scopeType: "channel",
      scopeId: "chn_abc",
      mode: "all",
    });

    // GET reflects it.
    const get = await signedReq(b, alice, "GET", "/api/me/notification-settings");
    expect(get.status).toBe(200);
    const listed = (await get.json()) as { prefs: Array<{ scopeId: string; mode: string }> };
    expect(listed.prefs).toEqual([{ scopeType: "channel", scopeId: "chn_abc", mode: "all" }]);

    // Invalid mode → 400.
    const badMode = await signedReq(b, alice, "PUT", "/api/me/notification-settings", {
      scopeType: "channel",
      scopeId: "chn_abc",
      mode: "loud",
    });
    expect(badMode.status).toBe(400);

    // scopeId prefix must match the scopeType → 400.
    const badPrefix = await signedReq(b, alice, "PUT", "/api/me/notification-settings", {
      scopeType: "group",
      scopeId: "chn_abc",
      mode: "none",
    });
    expect(badPrefix.status).toBe(400);

    // DELETE clears it.
    const del = await signedReq(
      b,
      alice,
      "DELETE",
      "/api/me/notification-settings?scopeType=channel&scopeId=chn_abc",
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ cleared: true });

    const after = await signedReq(b, alice, "GET", "/api/me/notification-settings");
    expect(((await after.json()) as { prefs: unknown[] }).prefs).toEqual([]);

    // Unsigned → 401.
    const anon = await b.app.request("/api/me/notification-settings", { method: "GET" });
    expect(anon.status).toBe(401);
  });
});
