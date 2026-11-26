/**
 * §7.1 message creation (ofscp#23): `POST …/channels/{channelId}/messages` and
 * the WS `message.create` command share one `MessageCreate` body, one order of
 * checks and one idempotency rule. Covers the REST create (201 / 200), the
 * `clientMessageId` echo (response, author's `message.created`, resume replay),
 * the duplicate answer (no fan-out; on WS no cursor), the 400 / 403 / 404
 * rejections, full-`Message` `dm.message` events, and migration 0037.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MessageSchema,
  WsDmMessageSchema,
  type WsEnvelope,
  WsMessageCreatedSchema,
  deriveDmId,
  rfc3339Timestamp,
} from "@forumall/shared";

import { openDb } from "../src/db/index.ts";
import { migrate, migrations, runMigrations } from "../src/db/migrate.ts";
import {
  type Booted,
  type Signer,
  type WsClient,
  addMember,
  boot as bootIn,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  signedReq,
  subscribe,
} from "./helpers/provider-harness.ts";

let tmp: string;
const booted: Booted[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-msg-create-"));
});
afterAll(() => {
  for (const b of booted) b.server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

function boot(name: string): Booted {
  const b = bootIn(tmp, name);
  booted.push(b);
  return b;
}

const text = (t: string) => ({ mime: "text/plain", text: t });
const attachment = {
  id: "att_1",
  mime: "image/png",
  url: "https://cdn.providera.test/att_1.png",
  size: 20480,
  width: 1024,
  height: 768,
};
const metadata = [{ schema: "https://x.example/meta/v1", version: "1", data: { a: 1 } }];

const messagesPath = (groupId: string, channelId: string) =>
  `/api/groups/${groupId}/channels/${channelId}/messages`;

function post(
  b: Booted,
  who: Signer,
  ids: { groupId: string; channelId: string },
  body: unknown,
): Promise<Response> {
  return signedReq(b, who, "POST", messagesPath(ids.groupId, ids.channelId), body);
}

async function created(b: Booted, who: Signer, ids: Ids, body: unknown) {
  const res = await post(b, who, ids, body);
  expect(res.status).toBe(201);
  return MessageSchema.parse(await res.json());
}

type Ids = { groupId: string; channelId: string };

/** Await the next `message.created` on `conn` and validate it. */
async function nextCreated(conn: WsClient): Promise<{ frame: WsEnvelope; data: CreatedData }> {
  const frame = await conn.ofType("message.created");
  return { frame, data: WsMessageCreatedSchema.parse(frame).data };
}
type CreatedData = ReturnType<typeof WsMessageCreatedSchema.parse>["data"];

/** The problem `errorCode` and status of a rejected REST call. */
async function problem(res: Response): Promise<{ status: number; errorCode: string }> {
  const body = (await res.json()) as { errorCode: string };
  return { status: res.status, errorCode: body.errorCode };
}

function wsCreate(conn: WsClient, id: string, ids: Ids, body: Record<string, unknown>): void {
  conn.send({ id, type: "message.create", ts: rfc3339Timestamp(), data: { ...ids, ...body } });
}

describe("REST POST …/messages (§7.1)", () => {
  test("201 stores every MessageCreate field, echoes clientMessageId and fans out", async () => {
    const b = boot("rest-create");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const ids = await makeGroupChannel(b, alice);
    addMember(b, ids.groupId, bob, "member");
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(bConn, ids.channelId);

    const parent = await created(b, alice, ids, { content: text("parent") });
    await nextCreated(bConn);

    const msg = await created(b, alice, ids, {
      clientMessageId: "cmsg_full",
      type: "memo",
      content: text("all the fields"),
      attachments: [attachment],
      reference: { type: "reply", id: parent.id },
      tags: ["#design"],
      metadata,
      author: "mallory@elsewhere.test",
    });
    expect(msg.author).toBe(alice.actor);
    expect(msg.clientMessageId).toBe("cmsg_full");
    expect(msg.type).toBe("memo");
    expect(msg.attachments).toEqual([attachment]);
    expect(msg.reference).toEqual({ type: "reply", id: parent.id });
    expect(msg.tags).toEqual(["#design"]);
    expect(msg.metadata).toEqual(metadata);

    // A REST create has no command id, so the fan-out carries no correlationId.
    const { frame, data } = await nextCreated(bConn);
    expect(frame.correlationId).toBeUndefined();
    expect(typeof data.cursor).toBe("string");
    expect(data.message).toEqual(msg);

    // History serves the same stored message (history items add their cursor).
    const hist = await signedReq(b, bob, "GET", messagesPath(ids.groupId, ids.channelId));
    const items = ((await hist.json()) as { items: unknown[] }).items.map((m) =>
      MessageSchema.parse(m),
    );
    expect(items.find((m) => m.id === msg.id)).toMatchObject(msg);
    bConn.close();
  });

  test("a duplicate clientMessageId answers 200 with the stored message and no fan-out", async () => {
    const b = boot("rest-dup");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const ids = await makeGroupChannel(b, alice);
    addMember(b, ids.groupId, bob, "member");
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(bConn, ids.channelId);

    const first = await created(b, alice, ids, { clientMessageId: "k1", content: text("once") });
    await nextCreated(bConn);

    // A retry whose remaining fields would fail the full schema is still
    // answered with the existing message: step 4 skips the later checks.
    const retry = await post(b, alice, ids, {
      clientMessageId: "k1",
      content: text("changed"),
      attachments: "garbage",
    });
    expect(retry.status).toBe(200);
    expect(MessageSchema.parse(await retry.json())).toEqual(first);

    // The duplicate fanned nothing out: the next event bob sees is a new message.
    const next = await created(b, alice, ids, { content: text("next") });
    const { data } = await nextCreated(bConn);
    expect(data.message.id).toBe(next.id);

    // The key is per author: bob may reuse it for his own message.
    const bobs = await created(b, bob, ids, { clientMessageId: "k1", content: text("bob") });
    expect(bobs.id).not.toBe(first.id);
    bConn.close();
  });

  test("400 for a body that fails the MessageCreate schema or names a bad reply", async () => {
    const b = boot("rest-400");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const other = await makeGroupChannel(b, alice);
    const elsewhere = await created(b, alice, other, { content: text("other channel") });
    const parent = await created(b, alice, ids, { content: text("parent") });

    const bad: unknown[] = [
      [],
      { content: { mime: "text/plain" } },
      { content: text("x"), type: "poll" },
      { content: text("x"), clientMessageId: "" },
      { content: text("x"), attachments: [{ id: "att_1" }] },
      { content: text("x"), tags: ["#ok", 7] },
      { content: text("x"), metadata: [{ schema: "x" }] },
      { content: text("x"), reference: { type: "quote", id: parent.id } },
      { content: text("x"), reference: { type: "reply", id: "msg_missing" } },
      { content: text("x"), reference: { type: "reply", id: elsewhere.id } },
    ];
    for (const body of bad) {
      expect({ body, ...(await problem(await post(b, alice, ids, body))) }).toEqual({
        body,
        status: 400,
        errorCode: "bad_request",
      });
    }

    const raw = await signedReq(
      b,
      alice,
      "POST",
      messagesPath(ids.groupId, ids.channelId),
      undefined,
      "{not json",
    );
    expect(raw.status).toBe(400);

    // None of the rejected bodies stored anything.
    const hist = await signedReq(b, alice, "GET", messagesPath(ids.groupId, ids.channelId));
    expect(((await hist.json()) as { items: unknown[] }).items.length).toBe(1);
  });

  test("404 for a missing or unreadable channel; 403 for post:<type> and reply-only", async () => {
    const b = boot("rest-authz");
    const owner = await registerUserWithKey(b, "owner");
    const member = await registerUserWithKey(b, "member");
    const stranger = await registerUserWithKey(b, "stranger");
    const ids = await makeGroupChannel(b, owner, "group", {
      "post:memo": ["admin"],
      replyOnly: ["member"],
      replyOnlyTo: ["memo"],
    });
    addMember(b, ids.groupId, member, "member");
    const body = { content: text("hi") };

    expect(await problem(await post(b, stranger, ids, body))).toEqual({
      status: 404,
      errorCode: "not_found",
    });
    const missing = { groupId: ids.groupId, channelId: "chn_missing" };
    expect((await post(b, owner, missing, body)).status).toBe(404);

    // post:memo is admin-only (checked before the duplicate lookup and the body).
    expect(await problem(await post(b, member, ids, { ...body, type: "memo" }))).toEqual({
      status: 403,
      errorCode: "forbidden",
    });
    // A reply-only member must carry a reference…
    expect((await post(b, member, ids, body)).status).toBe(403);
    // …a reply to a missing parent is 400 (step 5)…
    const toMissing = { ...body, reference: { type: "reply", id: "msg_missing" } };
    expect((await post(b, member, ids, toMissing)).status).toBe(400);
    // …and replyOnlyTo: ["memo"] refuses a reply to a plain message.
    const plain = await created(b, owner, ids, body);
    const toPlain = { ...body, reference: { type: "reply", id: plain.id } };
    expect((await post(b, member, ids, toPlain)).status).toBe(403);
    const memo = await created(b, owner, ids, { ...body, type: "memo" });
    const reply = await created(b, member, ids, {
      ...body,
      reference: { type: "reply", id: memo.id },
    });
    expect(reply.reference?.id).toBe(memo.id);
  });
});

describe("WS message.create (§7.1)", () => {
  test("author and subscribers get the full message; the author's copy echoes the key", async () => {
    const b = boot("ws-create");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const ids = await makeGroupChannel(b, alice);
    addMember(b, ids.groupId, bob, "member");
    const aConn = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);
    await subscribe(aConn, ids.channelId);
    await subscribe(bConn, ids.channelId);

    wsCreate(aConn, "cmd_1", ids, {
      clientMessageId: "cmsg_ws",
      type: "article",
      content: text("over ws"),
      attachments: [attachment],
      tags: ["#ws"],
      metadata,
    });
    const mine = await nextCreated(aConn);
    expect(mine.frame.correlationId).toBe("cmd_1");
    expect(typeof mine.data.cursor).toBe("string");
    expect(mine.data.message.clientMessageId).toBe("cmsg_ws");
    expect(mine.data.message.type).toBe("article");
    expect(mine.data.message.attachments).toEqual([attachment]);
    expect(mine.data.message.metadata).toEqual(metadata);
    const theirs = await nextCreated(bConn);
    expect(theirs.data.message).toEqual(mine.data.message);

    // The duplicate is answered to the requester only, correlated, cursor-less.
    wsCreate(aConn, "cmd_2", ids, { clientMessageId: "cmsg_ws", content: text("again") });
    const dup = await nextCreated(aConn);
    expect(dup.frame.correlationId).toBe("cmd_2");
    expect(dup.data.cursor).toBeUndefined();
    expect(dup.data.message).toEqual(mine.data.message);

    wsCreate(aConn, "cmd_3", ids, { content: text("fresh") });
    expect((await nextCreated(bConn)).data.message.content.text).toBe("fresh");
    aConn.close();
    bConn.close();
  });

  test("a resume replay carries the clientMessageId too", async () => {
    const b = boot("ws-replay");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const aConn = await connectAuthenticated(b, alice);
    await subscribe(aConn, ids.channelId);
    wsCreate(aConn, "cmd_a", ids, { content: text("before") });
    const before = await nextCreated(aConn);
    await created(b, alice, ids, { clientMessageId: "cmsg_replayed", content: text("after") });
    aConn.close();

    const resumed = await connectAuthenticated(b, alice);
    await subscribe(resumed, ids.channelId, before.data.cursor);
    const replay = await nextCreated(resumed);
    expect(replay.data.message.content.text).toBe("after");
    expect(replay.data.message.clientMessageId).toBe("cmsg_replayed");
    resumed.close();
  });

  test("an invalid body is a correlated bad_request error and stores nothing", async () => {
    const b = boot("ws-400");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const aConn = await connectAuthenticated(b, alice);
    await subscribe(aConn, ids.channelId);

    const bad: Record<string, unknown>[] = [
      { content: text("x"), attachments: {} },
      { content: text("x"), tags: "x" },
      { content: text("x"), metadata: [{}] },
      { content: text("x"), reference: { type: "quote", id: "msg_1" } },
      { content: text("x"), type: "poll" },
    ];
    for (const [i, body] of bad.entries()) {
      wsCreate(aConn, `bad_${i}`, ids, body);
      const err = await aConn.ofType("error");
      expect({ i, correlationId: err.correlationId, data: err.data }).toMatchObject({
        i,
        correlationId: `bad_${i}`,
        data: { code: "bad_request", status: 400 },
      });
    }
    expect(aConn.pending().some((f) => f.type === "message.created")).toBe(false);
    const hist = await signedReq(b, alice, "GET", messagesPath(ids.groupId, ids.channelId));
    expect(((await hist.json()) as { items: unknown[] }).items.length).toBe(0);
    aConn.close();
  });
});

describe("dm.message carries the full Message (§7.4)", () => {
  test("type is ignored (stored as message); event and responses echo clientMessageId", async () => {
    const b = boot("dm-full");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const bConn = await connectAuthenticated(b, bob);
    const path = `/api/federation/dms/${dmId}/messages`;
    const body = {
      clientMessageId: "cmsg_dm",
      type: "article",
      content: text("hey"),
      attachments: [attachment],
    };

    const res = await signedReq(b, alice, "POST", path, body);
    expect(res.status).toBe(201);
    const stored = MessageSchema.parse(await res.json());
    expect(stored.type).toBe("message");
    expect(stored.clientMessageId).toBe("cmsg_dm");

    const evt = WsDmMessageSchema.parse(await bConn.ofType("dm.message"));
    expect(evt.data.dmId).toBe(dmId);
    expect(evt.data.message).toEqual(stored);
    expect(evt.data.message.attachments).toEqual([attachment]);
    expect(evt.data.message.metadata).toEqual([]);

    const dup = await signedReq(b, alice, "POST", path, body);
    expect(dup.status).toBe(200);
    expect(MessageSchema.parse(await dup.json())).toEqual(stored);
    bConn.close();
  });
});

describe("migration 0037_messages_metadata", () => {
  test("adds messages.metadata and backfills existing rows with []", () => {
    const db = openDb(join(tmp, "m0037.sqlite"));
    const id = "0037_messages_metadata";
    runMigrations(
      db,
      migrations.filter((m) => m.id !== id),
    );
    db.sqlite.exec(`
      INSERT INTO messages (id, channel_id, group_id, author, type, content, attachments,
        reference, tags, seq, created_at, edited_at, deleted_at, edit_until, client_message_id)
      VALUES ('msg_old', 'chn_1', 'grp_1', 'alice@providera.test', 'message',
        '{"mime":"text/plain","text":"old"}', '[]', NULL, '[]', 1, 1, NULL, NULL, 2, NULL);
    `);
    expect(migrate(db)).toEqual([id]);
    const row = db.sqlite
      .query<{ metadata: string }, []>("SELECT metadata FROM messages WHERE id = 'msg_old'")
      .get();
    expect(row?.metadata).toBe("[]");
    expect(migrate(db)).toEqual([]);
    db.sqlite.close();
  });
});
