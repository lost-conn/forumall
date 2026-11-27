/**
 * Message create semantics over both transports (§5.2.1, §5.3, §7.1):
 *
 *  - `text/plain` and `text/markdown` bodies are accepted for every message
 *    type (`message`, `memo`, `article`), on a REST or WS create and an edit;
 *  - the WS half of "over both": an unreadable channel is `not_found`, a
 *    `post:<type>`, `replyOnly` or `replyOnlyTo` refusal is `forbidden`, and a
 *    permitted memo and a valid reply are stored;
 *  - REST create in a missing group is 404;
 *  - `(author, channelId, clientMessageId)` idempotency: a duplicate answers
 *    the message as it now stands (edited, or a tombstone), the key is per
 *    channel, and a reply-restricted retry is judged as sent (no `reference`
 *    → 403);
 *  - a non-string article `title` / `summary` is a 400 on a create and an edit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, MessageSchema, rfc3339Timestamp } from "@forumall/shared";

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
  tmp = mkdtempSync(join(tmpdir(), "forumall-msg-semantics-"));
});
afterAll(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

function boot(name: string): Booted {
  const b = bootIn(tmp, name);
  booted.push(b);
  return b;
}

type Ids = { groupId: string; channelId: string };

const TYPES = ["message", "memo", "article"] as const;
const text = (t: string) => ({ mime: "text/plain", text: t });
const markdown = (t: string) => ({ mime: "text/markdown", text: t });
const messagesPath = (ids: Ids) => `/api/groups/${ids.groupId}/channels/${ids.channelId}/messages`;

function post(b: Booted, who: Signer, ids: Ids, body: unknown): Promise<Response> {
  return signedReq(b, who, "POST", messagesPath(ids), body);
}

async function created(b: Booted, who: Signer, ids: Ids, body: unknown): Promise<Message> {
  const res = await post(b, who, ids, body);
  expect(res.status).toBe(201);
  return MessageSchema.parse(await res.json());
}

async function history(b: Booted, who: Signer, ids: Ids): Promise<Message[]> {
  const res = await signedReq(b, who, "GET", messagesPath(ids));
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: unknown[] }).items.map((m) => MessageSchema.parse(m));
}

/** Send a WS `message.create` and await its correlated answer (event or error). */
async function wsCreate(
  conn: WsClient,
  id: string,
  ids: Ids,
  body: Record<string, unknown>,
): Promise<{ type: string; data: unknown }> {
  conn.send({ id, type: "message.create", ts: rfc3339Timestamp(), data: { ...ids, ...body } });
  const frame = await conn.next((f) => f.correlationId === id);
  return { type: frame.type, data: frame.data };
}

function wsMessage(answer: { type: string; data: unknown }): Message {
  expect(answer.type).toBe("message.created");
  return MessageSchema.parse((answer.data as { message: unknown }).message);
}

function wsErrorCode(answer: { type: string; data: unknown }): string {
  expect(answer.type).toBe("error");
  return (answer.data as { code: string }).code;
}

describe("text/plain and text/markdown for every type (§5.3)", () => {
  test("REST create, history and edit keep a markdown body of each type", async () => {
    const b = boot("md-rest");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    for (const type of TYPES) {
      const msg = await created(b, alice, ids, { type, content: markdown(`# ${type}\n*hi*`) });
      expect(msg.type).toBe(type);
      expect(msg.content).toEqual(markdown(`# ${type}\n*hi*`));

      const edit = await signedReq(b, alice, "PATCH", `${messagesPath(ids)}/${msg.id}`, {
        content: markdown(`**${type}** edited`),
      });
      expect(edit.status).toBe(200);
      expect(MessageSchema.parse(await edit.json()).content).toEqual(
        markdown(`**${type}** edited`),
      );
      const plain = await created(b, alice, ids, { type, content: text(`${type} plain`) });
      expect(plain.content).toEqual(text(`${type} plain`));
    }
    const stored = await history(b, alice, ids);
    for (const type of TYPES) {
      expect(
        stored.find((m) => m.type === type && m.content.mime === "text/markdown"),
      ).toBeDefined();
    }
  });

  test("WS create keeps a markdown body of each type", async () => {
    const b = boot("md-ws");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const conn = await connectAuthenticated(b, alice);
    await subscribe(conn, ids.channelId);
    for (const type of TYPES) {
      const msg = wsMessage(
        await wsCreate(conn, `md_${type}`, ids, { type, content: markdown(`_${type}_`) }),
      );
      expect(msg.type).toBe(type);
      expect(msg.content).toEqual(markdown(`_${type}_`));
    }
    conn.close();
  });
});

describe("WS message.create authorization (§5.2.1, §7.1)", () => {
  test("an unreadable channel is not_found, and nothing is stored", async () => {
    const b = boot("ws-404");
    const owner = await registerUserWithKey(b, "owner");
    const stranger = await registerUserWithKey(b, "stranger");
    const ids = await makeGroupChannel(b, owner, "group");
    const conn = await connectAuthenticated(b, stranger);
    expect(wsErrorCode(await wsCreate(conn, "c404", ids, { content: text("hi") }))).toBe(
      "not_found",
    );
    expect(await history(b, owner, ids)).toEqual([]);
    conn.close();
  });

  test("post:<type>, replyOnly and replyOnlyTo refusals are forbidden; memo and reply stored", async () => {
    const b = boot("ws-403");
    const owner = await registerUserWithKey(b, "owner");
    const member = await registerUserWithKey(b, "member");
    const ids = await makeGroupChannel(b, owner, "group", {
      "post:memo": ["admin"],
      replyOnly: ["member"],
      replyOnlyTo: ["memo"],
    });
    addMember(b, ids.groupId, member, "member");
    const plain = await created(b, owner, ids, { content: text("plain") });
    const conn = await connectAuthenticated(b, member);
    const ownerConn = await connectAuthenticated(b, owner);
    await subscribe(conn, ids.channelId);
    await subscribe(ownerConn, ids.channelId);

    // The owner may post a memo over WS.
    const memo = wsMessage(
      await wsCreate(ownerConn, "c_memo_ok", ids, { type: "memo", content: text("m") }),
    );
    expect(memo.type).toBe("memo");
    const toMemo = { content: text("reply"), reference: { type: "reply", id: memo.id } };

    // post:memo is admin-only. The member's memo is a valid reply to a memo, so
    // it satisfies replyOnly and replyOnlyTo: only the post:<type> check refuses it.
    const memoReply = { ...toMemo, type: "memo" };
    expect(wsErrorCode(await wsCreate(conn, "c_memo", ids, memoReply))).toBe("forbidden");
    // replyOnly: a member must carry a reference…
    expect(wsErrorCode(await wsCreate(conn, "c_top", ids, { content: text("top") }))).toBe(
      "forbidden",
    );
    // …and replyOnlyTo: ["memo"] refuses a reply to a plain message.
    const toPlain = { content: text("r"), reference: { type: "reply", id: plain.id } };
    expect(wsErrorCode(await wsCreate(conn, "c_plain", ids, toPlain))).toBe("forbidden");

    // The same reply as a plain message is permitted and stored.
    const reply = wsMessage(await wsCreate(conn, "c_reply", ids, toMemo));
    expect(reply.reference).toEqual({ type: "reply", id: memo.id });
    expect(reply.author).toBe(member.actor);

    expect((await history(b, owner, ids)).map((m) => m.id).sort()).toEqual(
      [plain.id, memo.id, reply.id].sort(),
    );
    conn.close();
    ownerConn.close();
  });
});

describe("REST create (§7.1)", () => {
  test("a missing group is 404", async () => {
    const b = boot("rest-no-group");
    const alice = await registerUserWithKey(b, "alice");
    const { channelId } = await makeGroupChannel(b, alice);
    const res = await post(b, alice, { groupId: "grp_missing", channelId }, { content: text("x") });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe("not_found");
  });

  test("a non-string title or summary is 400 on a create and an edit", async () => {
    const b = boot("rest-article-fields");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const article = { type: "article", content: markdown("body") };
    for (const bad of [{ title: 7 }, { summary: ["s"] }, { title: { t: 1 } }]) {
      expect((await post(b, alice, ids, { ...article, ...bad })).status).toBe(400);
    }
    const msg = await created(b, alice, ids, { ...article, title: "T", summary: "S" });
    for (const bad of [{ title: 7 }, { summary: false }]) {
      const res = await signedReq(b, alice, "PATCH", `${messagesPath(ids)}/${msg.id}`, bad);
      expect(res.status).toBe(400);
    }
    const [stored] = await history(b, alice, ids);
    expect({ title: stored?.title, summary: stored?.summary }).toEqual({
      title: "T",
      summary: "S",
    });
  });
});

describe("clientMessageId idempotency (§7.1)", () => {
  test("a duplicate answers the message as it now stands: edited, then a tombstone", async () => {
    const b = boot("idem-current");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const first = await created(b, alice, ids, { clientMessageId: "k", content: text("v1") });

    const edit = await signedReq(b, alice, "PATCH", `${messagesPath(ids)}/${first.id}`, {
      content: text("v2"),
    });
    expect(edit.status).toBe(200);
    const retry = await post(b, alice, ids, { clientMessageId: "k", content: text("v1") });
    expect(retry.status).toBe(200);
    const afterEdit = MessageSchema.parse(await retry.json());
    expect(afterEdit.id).toBe(first.id);
    expect(afterEdit.content).toEqual(text("v2"));
    expect(afterEdit.editedAt).toBeDefined();

    const del = await signedReq(b, alice, "DELETE", `${messagesPath(ids)}/${first.id}`);
    expect(del.status).toBe(204);
    const again = await post(b, alice, ids, { clientMessageId: "k", content: text("v1") });
    expect(again.status).toBe(200);
    const tombstone = MessageSchema.parse(await again.json());
    expect(tombstone.id).toBe(first.id);
    expect(tombstone.deletedAt).toBeDefined();
    expect(tombstone.content.text).toBe("");
    expect(await history(b, alice, ids)).toHaveLength(1);
  });

  test("the key is per channel: the same key in another channel creates a new message", async () => {
    const b = boot("idem-channel");
    const alice = await registerUserWithKey(b, "alice");
    const one = await makeGroupChannel(b, alice);
    const two = await makeGroupChannel(b, alice);
    const a = await created(b, alice, one, { clientMessageId: "k", content: text("one") });
    const c = await created(b, alice, two, { clientMessageId: "k", content: text("two") });
    expect(c.id).not.toBe(a.id);
    expect(c.content).toEqual(text("two"));
    expect(await history(b, alice, one)).toHaveLength(1);
    expect(await history(b, alice, two)).toHaveLength(1);
  });

  test("a reply-only actor's retry without reference is 403, not the stored reply", async () => {
    const b = boot("idem-reply-only");
    const owner = await registerUserWithKey(b, "owner");
    const member = await registerUserWithKey(b, "member");
    const ids = await makeGroupChannel(b, owner, "group", { replyOnly: ["member"] });
    addMember(b, ids.groupId, member, "member");
    const parent = await created(b, owner, ids, { content: text("parent") });
    const reference = { type: "reply", id: parent.id };
    const reply = await created(b, member, ids, {
      clientMessageId: "k",
      content: text("r"),
      reference,
    });

    const bare = await post(b, member, ids, { clientMessageId: "k", content: text("r") });
    expect(bare.status).toBe(403);
    const withRef = await post(b, member, ids, {
      clientMessageId: "k",
      content: text("r"),
      reference,
    });
    expect(withRef.status).toBe(200);
    expect(MessageSchema.parse(await withRef.json()).id).toBe(reply.id);
  });
});
