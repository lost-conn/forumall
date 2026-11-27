/**
 * Per-type edit windows (§5.3 `permissions.editUntil`, §7.1 *Editing*):
 *
 *  - chat types (`message`, `memo`) get `MESSAGE_EDIT_WINDOW_SECONDS`;
 *  - an `article` gets no window by default: no `permissions` on the create
 *    response, the WS events or history, and its author may edit it at any
 *    time, over REST and WS ("no limit when absent");
 *  - `ARTICLE_EDIT_WINDOW_SECONDS` gives articles a window instead, enforced
 *    like any other;
 *  - the config knob's parsing, the window helpers, and migration 0042 (which
 *    makes `messages.edit_until` nullable, keeping rows and indexes).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, MessageSchema, rfc3339Timestamp } from "@forumall/shared";
import { eq } from "drizzle-orm";

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate, migrations, runMigrations } from "../src/db/migrate.ts";
import { messages } from "../src/db/schema.ts";
import { editWindowEnd, isEditWindowOpen } from "../src/provider/edit-window.ts";
import {
  type Booted,
  type Signer,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  signedReq,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-edit-window-");

type Ids = { groupId: string; channelId: string };
const text = (t: string) => ({ mime: "text/plain", text: t });
const messagesPath = (ids: Ids) => `/api/groups/${ids.groupId}/channels/${ids.channelId}/messages`;

async function create(b: Booted, who: Signer, ids: Ids, body: unknown): Promise<Message> {
  const res = await signedReq(b, who, "POST", messagesPath(ids), body);
  expect(res.status).toBe(201);
  return MessageSchema.parse(await res.json());
}

function edit(b: Booted, who: Signer, ids: Ids, id: string, body: unknown): Promise<Response> {
  return signedReq(b, who, "PATCH", `${messagesPath(ids)}/${id}`, body);
}

/** The window length a message reports, in seconds. */
function windowSeconds(msg: Message): number {
  const until = msg.permissions?.editUntil;
  if (until === undefined) throw new Error(`${msg.id} has no editUntil`);
  return (Date.parse(until) - Date.parse(msg.createdAt)) / 1000;
}

function storedEditUntil(b: Booted, id: string): number | null | undefined {
  return b.db.drizzle
    .select({ editUntil: messages.editUntil })
    .from(messages)
    .where(eq(messages.id, id))
    .all()[0]?.editUntil;
}

/** Move a message's edit window into the past (as if it had elapsed). */
function expireWindow(b: Booted, id: string): void {
  b.db.drizzle
    .update(messages)
    .set({ editUntil: Date.now() - 1000 })
    .where(eq(messages.id, id))
    .run();
}

describe("edit windows per type (§7.1)", () => {
  test("chat types get the chat window; an article has no editUntil anywhere", async () => {
    const b = boot("default-windows");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const conn = await connectAuthenticated(b, alice);
    await subscribe(conn, ids.channelId);

    const chat = await create(b, alice, ids, { content: text("chat") });
    const memo = await create(b, alice, ids, { type: "memo", content: text("memo") });
    expect(windowSeconds(chat)).toBe(b.config.messageEditWindowSeconds);
    expect(windowSeconds(memo)).toBe(b.config.messageEditWindowSeconds);

    conn.send({
      id: "cmd_article",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: { ...ids, type: "article", content: text("long read") },
    });
    const evt = await conn.next((f) => f.correlationId === "cmd_article");
    const article = MessageSchema.parse((evt.data as { message: unknown }).message);
    expect(article.type).toBe("article");
    expect(article.permissions).toBeUndefined();
    expect(storedEditUntil(b, article.id)).toBeNull();

    const hist = await signedReq(b, alice, "GET", messagesPath(ids));
    const items = ((await hist.json()) as { items: Message[] }).items;
    const listed = items.find((m) => m.id === article.id);
    expect(listed).toBeDefined();
    expect(listed?.permissions).toBeUndefined();
    conn.close();
  });

  test("an article stays editable over REST and WS; a chat message's window still closes", async () => {
    const b = boot("article-unlimited");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const article = await create(b, alice, ids, { type: "article", content: text("v1") });
    const chat = await create(b, alice, ids, { content: text("chat") });
    expireWindow(b, chat.id);
    expect((await edit(b, alice, ids, chat.id, { content: text("late") })).status).toBe(403);

    const res = await edit(b, alice, ids, article.id, { content: text("v2"), title: "T" });
    expect(res.status).toBe(200);
    const edited = MessageSchema.parse(await res.json());
    expect(edited.editedAt).toBeDefined();
    expect(edited.permissions).toBeUndefined();

    const conn = await connectAuthenticated(b, alice);
    await subscribe(conn, ids.channelId);
    conn.send({
      id: "cmd_edit",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: { ...ids, messageId: article.id, content: text("v3") },
    });
    const evt = await conn.next((f) => f.correlationId === "cmd_edit");
    expect(evt.type).toBe("message.updated");
    const updated = MessageSchema.parse((evt.data as { message: unknown }).message);
    expect(updated.content).toEqual(text("v3"));
    expect(updated.permissions).toBeUndefined();
    conn.close();
  });

  test("ARTICLE_EDIT_WINDOW_SECONDS gives articles a window, enforced like any other", async () => {
    const b = boot("article-window", undefined, { ARTICLE_EDIT_WINDOW_SECONDS: "86400" });
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const article = await create(b, alice, ids, { type: "article", content: text("a") });
    const chat = await create(b, alice, ids, { content: text("c") });
    expect(windowSeconds(article)).toBe(86400);
    expect(windowSeconds(chat)).toBe(b.config.messageEditWindowSeconds);

    expect((await edit(b, alice, ids, article.id, { content: text("in time") })).status).toBe(200);
    expireWindow(b, article.id);
    expect((await edit(b, alice, ids, article.id, { content: text("late") })).status).toBe(403);
  });
});

describe("edit window helpers and config", () => {
  const base = { messageEditWindowSeconds: 900, articleEditWindowSeconds: null };

  test("editWindowEnd picks the window by type; null means no limit", () => {
    expect(editWindowEnd(base, "message", 1000)).toBe(901_000);
    expect(editWindowEnd(base, "memo", 1000)).toBe(901_000);
    expect(editWindowEnd(base, "article", 1000)).toBeNull();
    expect(editWindowEnd({ ...base, articleEditWindowSeconds: 60 }, "article", 1000)).toBe(61_000);
  });

  test("isEditWindowOpen: open strictly before the end, always when there is none", () => {
    expect(isEditWindowOpen(null, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isEditWindowOpen(2000, 1999)).toBe(true);
    expect(isEditWindowOpen(2000, 2000)).toBe(false);
    expect(isEditWindowOpen(2000, 2001)).toBe(false);
  });

  test("ARTICLE_EDIT_WINDOW_SECONDS: unset or empty → no limit; a value ≥ 0; else rejected", () => {
    expect(loadConfig({}).articleEditWindowSeconds).toBeNull();
    expect(loadConfig({ ARTICLE_EDIT_WINDOW_SECONDS: "" }).articleEditWindowSeconds).toBeNull();
    expect(loadConfig({ ARTICLE_EDIT_WINDOW_SECONDS: "0" }).articleEditWindowSeconds).toBe(0);
    expect(loadConfig({ ARTICLE_EDIT_WINDOW_SECONDS: "3600" }).articleEditWindowSeconds).toBe(3600);
    expect(() => loadConfig({ ARTICLE_EDIT_WINDOW_SECONDS: "-1" })).toThrow();
    expect(() => loadConfig({ ARTICLE_EDIT_WINDOW_SECONDS: "soon" })).toThrow();
  });
});

describe("migration 0042_messages_edit_until_nullable", () => {
  test("makes edit_until nullable, keeping rows and indexes", () => {
    const tmp = mkdtempSync(join(tmpdir(), "forumall-m0042-"));
    const db = openDb(join(tmp, "m0042.sqlite"));
    const id = "0042_messages_edit_until_nullable";
    runMigrations(
      db,
      migrations.filter((m) => m.id !== id),
    );
    db.sqlite.exec(`
      INSERT INTO messages (id, channel_id, group_id, author, type, content, attachments,
        reference, tags, seq, created_at, edited_at, deleted_at, edit_until, client_message_id,
        reply_to, metadata, mentions, title, summary, cover)
      VALUES ('msg_old', 'chn_1', 'grp_1', 'alice@providera.test', 'article',
        '{"mime":"text/plain","text":"old"}', '[]', NULL, '["#t"]', 1, 1, NULL, NULL, 2, 'k1',
        'msg_p', '[]', '["bob@providera.test"]', 'T', 'S', NULL);
    `);
    expect(migrate(db)).toEqual([id]);

    const col = db.sqlite
      .query<{ notnull: number }, []>(
        "SELECT \"notnull\" FROM pragma_table_info('messages') WHERE name = 'edit_until'",
      )
      .get();
    expect(col?.notnull).toBe(0);
    const old = db.sqlite
      .query<Record<string, unknown>, []>("SELECT * FROM messages WHERE id = 'msg_old'")
      .get();
    expect(old).toMatchObject({
      edit_until: 2,
      client_message_id: "k1",
      reply_to: "msg_p",
      tags: '["#t"]',
      mentions: '["bob@providera.test"]',
      title: "T",
      summary: "S",
    });

    const indexes = db.sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual([
      "idx_messages_author_channel_client_msg",
      "idx_messages_channel_reply_to",
      "idx_messages_channel_seq",
      "idx_messages_seq",
    ]);

    // A row without a window is now storable; the idempotency index still holds.
    const insert = (rowId: string, seq: number, key: string) =>
      db.sqlite.exec(`
        INSERT INTO messages (id, channel_id, group_id, author, type, content, attachments,
          tags, seq, created_at, edit_until, client_message_id)
        VALUES ('${rowId}', 'chn_1', 'grp_1', 'alice@providera.test', 'article',
          '{"mime":"text/plain","text":"new"}', '[]', '[]', ${seq}, 3, NULL, '${key}');
      `);
    insert("msg_new", 2, "k2");
    expect(() => insert("msg_dup", 3, "k1")).toThrow(/UNIQUE/);
    expect(migrate(db)).toEqual([]);
    db.sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
