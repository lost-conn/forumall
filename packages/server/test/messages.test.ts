/**
 * Message store + REST history reads tests (spec §5.3, §7.2).
 *
 * Drives the app in-process via `app.request(...)`, signing with the shared
 * `sign()` against a registered device key (same harness as `channels.test.ts`).
 * Messages are seeded directly via the `createMessage` store helper (the WS
 * create card owns the real create flow). Covers: schema-valid message mapping +
 * future `permissions.editUntil`; backward/forward keyset paging (stable,
 * non-overlapping, gap-free, walks the whole history); opaque (non-int) cursors
 * ordered by seq; `MessagesPageSchema` validation; and read authz (private 403,
 * public 200, unknown 404).
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
  type Message,
  MessageSchema,
  MessagesPageSchema,
  generateKeyPair,
  sign,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { groupMembers } from "../src/db/schema.ts";
import { createMessage } from "../src/provider/messages.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-messages-"));
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

async function createChannel(
  app: App,
  signer: Signer,
  groupId: string,
  body: Record<string, unknown>,
): Promise<Channel> {
  const res = await signedRequest(app, signer, "POST", `/api/groups/${groupId}/channels`, body);
  expect(res.status).toBe(201);
  return (await res.json()) as Channel;
}

/** Insert a membership row directly (membership card owns the real join flow). */
function addMember(db: Db, groupId: string, signer: Signer, role: string): void {
  db.drizzle
    .insert(groupMembers)
    .values({ groupId, user: signer.actor, role, joinedAt: Date.now() })
    .run();
}

/** Seed `n` messages into a channel via the store helper; returns ids in order. */
function seedMessages(
  db: Db,
  config: Config,
  groupId: string,
  channelId: string,
  author: string,
  n: number,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const rec = createMessage(db, config, {
      channelId,
      groupId,
      author,
      type: "message",
      content: { text: `msg ${i}`, mime: "text/plain" },
    });
    ids.push(rec.message.id);
  }
  return ids;
}

interface Page {
  items: Message[];
  page: { nextCursor?: string; prevCursor?: string };
}

// ---------------------------------------------------------------------------
// createMessage → schema-valid Message
// ---------------------------------------------------------------------------

describe("createMessage (§5.3)", () => {
  test("maps to a schema-valid Message with a future editUntil", () => {
    const { config, db } = freshApp("msg-create");
    const rec = createMessage(db, config, {
      channelId: "chn_x",
      groupId: "grp_x",
      author: `alice@${DOMAIN}`,
      type: "message",
      content: { text: "hi", mime: "text/plain" },
    });
    expect(() => MessageSchema.parse(rec.message)).not.toThrow();
    expect(rec.message.id.startsWith("msg_")).toBe(true);
    expect(rec.message.author).toBe(`alice@${DOMAIN}`);
    const editUntil = Date.parse(rec.message.permissions?.editUntil ?? "");
    expect(Number.isNaN(editUntil)).toBe(false);
    expect(editUntil).toBeGreaterThan(Date.now());
    // seq starts at 1 and the cursor is opaque (not the raw int).
    expect(rec.seq).toBe(1);
    expect(rec.cursor).not.toBe("1");
  });

  test("seq is monotonically increasing across messages", () => {
    const { config, db } = freshApp("msg-seq");
    const a = createMessage(db, config, {
      channelId: "c",
      groupId: "g",
      author: `a@${DOMAIN}`,
      type: "message",
      content: { text: "1", mime: "text/plain" },
    });
    const b = createMessage(db, config, {
      channelId: "c",
      groupId: "g",
      author: `a@${DOMAIN}`,
      type: "message",
      content: { text: "2", mime: "text/plain" },
    });
    expect(b.seq).toBeGreaterThan(a.seq);
  });
});

// ---------------------------------------------------------------------------
// GET history — paging
// ---------------------------------------------------------------------------

describe("GET .../messages (§7.2, paging)", () => {
  test("backward paging walks the whole history with no gaps/dupes", async () => {
    const { app, config, db } = freshApp("msg-backward");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    const total = 23;
    const orderedIds = seedMessages(db, config, group.id, channel.id, alice.actor, total);
    const base = `/api/groups/${group.id}/channels/${channel.id}/messages`;

    // Walk backward (newest-first) in pages of 10.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = `${base}?direction=backward&limit=10${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await app.request(url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      expect(() => MessagesPageSchema.parse(body)).not.toThrow();
      for (const m of body.items) seen.push(m.id);
      pages++;
      if (!body.page.nextCursor) break;
      cursor = body.page.nextCursor;
      expect(pages).toBeLessThan(10); // guard against an infinite loop
    }

    // Newest-first = the reverse of creation order; complete with no dupes.
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual([...orderedIds].reverse());
  });

  test("forward paging walks the whole history oldest-first", async () => {
    const { app, config, db } = freshApp("msg-forward");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    const total = 17;
    const orderedIds = seedMessages(db, config, group.id, channel.id, alice.actor, total);
    const base = `/api/groups/${group.id}/channels/${channel.id}/messages`;

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const url = `${base}?direction=forward&limit=5${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await app.request(url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      for (const m of body.items) seen.push(m.id);
      if (!body.page.nextCursor) break;
      cursor = body.page.nextCursor;
    }

    expect(seen).toEqual(orderedIds);
  });

  test("prevCursor walks back to the previous page", async () => {
    const { app, config, db } = freshApp("msg-prev");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    seedMessages(db, config, group.id, channel.id, alice.actor, 30);
    const base = `/api/groups/${group.id}/channels/${channel.id}/messages`;

    // First backward page (newest 10), then the next page.
    const p1 = (await (await app.request(`${base}?direction=backward&limit=10`)).json()) as Page;
    const p2 = (await (
      await app.request(`${base}?direction=backward&limit=10&cursor=${p1.page.nextCursor}`)
    ).json()) as Page;

    // From p2, walking forward via prevCursor returns p1's items (oldest-first
    // within that page); the id sets match the first page.
    const back = (await (
      await app.request(`${base}?direction=forward&limit=10&cursor=${p2.page.prevCursor}`)
    ).json()) as Page;
    expect(new Set(back.items.map((m) => m.id))).toEqual(new Set(p1.items.map((m) => m.id)));
  });

  test("cursor is opaque (not a raw int) and ordering is consistent with seq", async () => {
    const { app, config, db } = freshApp("msg-opaque");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "public" });

    seedMessages(db, config, group.id, channel.id, alice.actor, 5);
    const base = `/api/groups/${group.id}/channels/${channel.id}/messages`;
    const body = (await (await app.request(`${base}?direction=forward&limit=3`)).json()) as Page;

    expect(body.page.nextCursor).toBeDefined();
    // Not a bare integer.
    expect(/^\d+$/.test(body.page.nextCursor ?? "")).toBe(false);
    // Forward order is oldest-first by creation (= seq ascending).
    expect(body.items.map((m) => m.content.text)).toEqual(["msg 0", "msg 1", "msg 2"]);
  });
});

// ---------------------------------------------------------------------------
// GET history — authorization
// ---------------------------------------------------------------------------

describe("GET .../messages (§7.2, authz)", () => {
  test("public channel readable by anyone → 200", async () => {
    const { app, config, db } = freshApp("msg-authz-public");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "public" });
    seedMessages(db, config, group.id, channel.id, alice.actor, 3);

    const res = await app.request(`/api/groups/${group.id}/channels/${channel.id}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(() => MessagesPageSchema.parse(body)).not.toThrow();
    expect(body.items.length).toBe(3);
  });

  test("private channel: non-member → 403, member → 200", async () => {
    const { app, config, db } = freshApp("msg-authz-private");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });
    const channel = await createChannel(app, alice, group.id, { type: "text", tier: "private" });
    seedMessages(db, config, group.id, channel.id, alice.actor, 2);
    const path = `/api/groups/${group.id}/channels/${channel.id}/messages`;

    const forbidden = await signedRequest(app, bob, "GET", path);
    expect(forbidden.status).toBe(403);

    addMember(db, group.id, bob, "member");
    const ok = await signedRequest(app, bob, "GET", path);
    expect(ok.status).toBe(200);
  });

  test("unknown channel → 404; unknown group → 404", async () => {
    const { app } = freshApp("msg-authz-404");
    const alice = await registerUserWithKey(app, "alice");
    const group = await createGroup(app, alice, { name: "G", tier: "public" });

    const noChannel = await app.request(`/api/groups/${group.id}/channels/chn_nope/messages`);
    expect(noChannel.status).toBe(404);

    const noGroup = await app.request("/api/groups/grp_nope/channels/chn_x/messages");
    expect(noGroup.status).toBe(404);
  });
});
