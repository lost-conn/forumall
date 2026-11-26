/**
 * Channel message edits (spec §7.1 *Editing*, `MessageUpdate`) on the channel
 * PATCH and WS `message.update`:
 *
 *  - each field present replaces the stored value, each absent field is kept:
 *    `content`, `attachments` (in full; `[]` clears them), `tags`, `mentions`;
 *    `type`, `reference` and `metadata` are ignored;
 *  - on an `article`, `title` / `summary` / `cover` too, where `null` removes
 *    the field; the result's `cover` must name one of its attachments (400);
 *  - on any other type the article fields are ignored, and an edit carrying
 *    only them is a 400;
 *  - attachments get the §5.8 checks a create applies; mentions must be
 *    canonical actors (400);
 *  - a missing message (404) and a non-author (403) are answered before the
 *    body is judged (400);
 *  - `message.updated` carries the full updated message.
 *
 * DM edits are in `message-edit-dm.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, MessageSchema, rfc3339Timestamp } from "@forumall/shared";

import { hostedAttachment } from "./helpers/attachments.ts";
import {
  type Booted,
  type Signer,
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
  tmp = mkdtempSync(join(tmpdir(), "forumall-msg-edit-fields-"));
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

interface Posted {
  readonly groupId: string;
  readonly channelId: string;
  readonly messageId: string;
  /** The message's PATCH path. */
  readonly path: string;
}

/** A new channel owned by `author` with one message created from `body`. */
async function channelMessage(
  b: Booted,
  author: Signer,
  body: Record<string, unknown> = { content: text("orig") },
): Promise<Posted> {
  const ids = await makeGroupChannel(b, author);
  const base = `/api/groups/${ids.groupId}/channels/${ids.channelId}/messages`;
  const res = await signedReq(b, author, "POST", base, body);
  expect(res.status).toBe(201);
  const messageId = ((await res.json()) as { id: string }).id;
  return { ...ids, messageId, path: `${base}/${messageId}` };
}

/** The stored message, as history returns it (without the item's `cursor`). */
async function stored(b: Booted, who: Signer, m: Posted): Promise<Message> {
  const res = await signedReq(
    b,
    who,
    "GET",
    `/api/groups/${m.groupId}/channels/${m.channelId}/messages`,
  );
  const items = (await res.json()) as { items: { id: string; cursor?: string }[] };
  const found = items.items.find((i) => i.id === m.messageId);
  if (!found) throw new Error("message not in history");
  const { cursor: _cursor, ...message } = found;
  return MessageSchema.parse(message);
}

/** PATCH `body`; expect `status`; return the parsed message on a 200. */
async function patch(
  b: Booted,
  who: Signer,
  m: Posted,
  body: unknown,
  status = 200,
): Promise<Message | null> {
  const res = await signedReq(b, who, "PATCH", m.path, body);
  const json = await res.json();
  expect({ body, status: res.status }).toEqual({ body, status });
  return status === 200 ? MessageSchema.parse(json) : null;
}

describe("channel PATCH (§7.1): each field present replaces the stored value", () => {
  test("content, attachments, tags and mentions; absent fields kept; type/reference/metadata ignored", async () => {
    const b = boot("rest-replace");
    const alice = await registerUserWithKey(b, "alice");
    const first = hostedAttachment(b, alice, { filename: "one.png" });
    const second = hostedAttachment(b, alice, { filename: "two.png" });
    const metadata = [{ schema: "https://x.example/meta/v1", version: "1", data: { a: 1 } }];
    const m = await channelMessage(b, alice, {
      content: text("orig"),
      attachments: [first],
      tags: ["#old"],
      mentions: ["bob@providera.test"],
      metadata,
    });

    let msg = await patch(b, alice, m, { tags: ["#new"] });
    expect(msg).toMatchObject({
      content: text("orig"),
      attachments: [first],
      tags: ["#new"],
      mentions: ["bob@providera.test"],
    });
    expect(typeof msg?.editedAt).toBe("string");

    msg = await patch(b, alice, m, { mentions: [] });
    expect(msg?.mentions).toEqual([]);
    expect(msg?.tags).toEqual(["#new"]);

    // `attachments: []` replaces the list in full: none remain.
    msg = await patch(b, alice, m, { attachments: [] });
    expect(msg?.attachments).toEqual([]);
    msg = await patch(b, alice, m, { attachments: [second, first] });
    expect(msg?.attachments).toEqual([second, first]);

    msg = await patch(b, alice, m, {
      content: text("new"),
      type: "memo",
      reference: { type: "reply", id: m.messageId },
      metadata: [],
    });
    expect(msg).toMatchObject({ content: text("new"), type: "message", metadata });
    expect(msg?.reference).toBeUndefined();
    expect(await stored(b, alice, m)).toEqual(msg as Message);
  });
});

describe("channel PATCH (§7.1): article fields", () => {
  test("title/summary/cover replace; null removes; the result's cover must name an attachment", async () => {
    const b = boot("rest-article");
    const alice = await registerUserWithKey(b, "alice");
    const img = hostedAttachment(b, alice);
    const img2 = hostedAttachment(b, alice);
    const m = await channelMessage(b, alice, {
      type: "article",
      content: text("body"),
      title: "T",
      summary: "S",
      attachments: [img],
      cover: img.id,
    });

    // The article fields count as the one field an edit needs here.
    let msg = await patch(b, alice, m, { title: "T2" });
    expect(msg).toMatchObject({ title: "T2", summary: "S", cover: img.id, content: text("body") });
    msg = await patch(b, alice, m, { summary: null });
    expect(msg?.summary).toBeUndefined();
    expect(msg?.title).toBe("T2");

    // A cover naming none of the attachments, as sent or as the result.
    await patch(b, alice, m, { cover: "att_missing" }, 400);
    await patch(b, alice, m, { attachments: [] }, 400);
    await patch(b, alice, m, { attachments: [img2] }, 400);
    expect(await stored(b, alice, m)).toMatchObject({ attachments: [img], cover: img.id });

    msg = await patch(b, alice, m, { attachments: [img2], cover: img2.id });
    expect(msg).toMatchObject({ attachments: [img2], cover: img2.id });
    msg = await patch(b, alice, m, { attachments: [], cover: null, title: null });
    expect(msg?.attachments).toEqual([]);
    expect(msg?.cover).toBeUndefined();
    expect(msg?.title).toBeUndefined();
    await patch(b, alice, m, { title: 7 }, 400);
  });

  test("non-article: article fields alone are a 400; beside another field they are ignored", async () => {
    const b = boot("rest-non-article");
    const alice = await registerUserWithKey(b, "alice");
    const m = await channelMessage(b, alice);

    await patch(b, alice, m, {}, 400);
    await patch(b, alice, m, { title: "T" }, 400);
    await patch(b, alice, m, { title: "T", summary: null, cover: null }, 400);
    expect((await stored(b, alice, m)).editedAt).toBeUndefined();

    const msg = await patch(b, alice, m, { tags: ["#a"], title: "T", cover: "att_x" });
    expect(msg?.tags).toEqual(["#a"]);
    expect(msg?.title).toBeUndefined();
    expect(msg?.cover).toBeUndefined();
  });
});

describe("channel PATCH (§7.1, §5.8): the create's checks apply to the edited fields", () => {
  test("attachments: hosted, the author's, matching the stored upload; stored as the provider's record", async () => {
    const b = boot("rest-attachments");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const mine = hostedAttachment(b, alice, { filename: "mine.png" });
    const bobs = hostedAttachment(b, bob);
    const m = await channelMessage(b, alice, { content: text("orig"), attachments: [mine] });

    const rejected: unknown[] = [
      [bobs],
      [{ ...mine, id: "att_unknown" }],
      [{ ...mine, id: "att_ext", url: "https://cdn.elsewhere.test/a.png" }],
      [{ ...mine, mime: "image/jpeg" }],
      [{ ...mine, size: mine.size + 1 }],
      [{ ...mine, hash: "sha-256:AAAA" }],
      [{ ...mine, url: "http://providera.test/api/media/x" }],
    ];
    for (const attachments of rejected) await patch(b, alice, m, { attachments }, 400);
    expect((await stored(b, alice, m)).editedAt).toBeUndefined();

    // The client's copy of the optional fields is not kept: no `expiresAt`
    // (only a minting provider sets it), no thumbnail this provider did not
    // store, the stored filename.
    const msg = await patch(b, alice, m, {
      attachments: [
        {
          ...mine,
          filename: "renamed.png",
          expiresAt: "2099-01-01T00:00:00Z",
          thumbnail: { ...mine, id: "att_thumb" },
        },
      ],
    });
    expect(msg?.attachments).toEqual([mine]);
  });

  test("mentions must be canonical actors", async () => {
    const b = boot("rest-mentions");
    const alice = await registerUserWithKey(b, "alice");
    const m = await channelMessage(b, alice);
    for (const mentions of [["Bob@providera.test"], ["bob@PROVIDERA.test"], ["https://x.test/u"]]) {
      await patch(b, alice, m, { mentions }, 400);
    }
    const msg = await patch(b, alice, m, { mentions: ["bob@providera.test", "carol@b.test"] });
    expect(msg?.mentions).toEqual(["bob@providera.test", "carol@b.test"]);
  });
});

describe("channel PATCH (§7.1): 404 and 403 come before the body is judged", () => {
  test("missing message → 404 and non-author → 403, whatever the body; the author's bad body → 400", async () => {
    const b = boot("rest-order");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const m = await channelMessage(b, alice);
    addMember(b, m.groupId, bob, "member");
    const missing = { ...m, path: m.path.replace(m.messageId, "msg_missing") };

    for (const body of [{}, { title: "T" }, { attachments: [{ id: "x" }] }, "junk"]) {
      await patch(b, alice, missing, body, 404);
      await patch(b, bob, m, body, 403);
      await patch(b, alice, m, body, 400);
    }
    const raw = await signedReq(b, bob, "PATCH", m.path, undefined, "{not json");
    expect(raw.status).toBe(403);
  });
});

describe("WS message.update (§7.1)", () => {
  test("applies every field and fans out the full message; errors are correlated, 403 before 400", async () => {
    const b = boot("ws-fields");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const att = hostedAttachment(b, alice);
    const m = await channelMessage(b, alice, {
      type: "article",
      content: text("orig"),
      title: "T",
    });
    addMember(b, m.groupId, bob, "member");
    const target = { groupId: m.groupId, channelId: m.channelId, messageId: m.messageId };
    const aWs = await connectAuthenticated(b, alice);
    const bWs = await connectAuthenticated(b, bob);
    await subscribe(aWs, m.channelId);
    await subscribe(bWs, m.channelId);
    const send = (ws: typeof aWs, id: string, data: unknown) =>
      ws.send({
        id,
        type: "message.update",
        ts: rfc3339Timestamp(),
        data: { ...target, ...(data as object) },
      });

    send(aWs, "cli_edit", {
      attachments: [att],
      cover: att.id,
      tags: ["#t"],
      mentions: ["bob@providera.test"],
      title: null,
      summary: "S",
    });
    const mine = await aWs.ofType("message.updated");
    expect(mine.correlationId).toBe("cli_edit");
    const theirs = await bWs.ofType("message.updated");
    expect(theirs.correlationId).toBeUndefined();
    const message = MessageSchema.parse((theirs.data as { message: unknown }).message);
    expect(message).toMatchObject({
      type: "article",
      content: text("orig"),
      attachments: [att],
      cover: att.id,
      tags: ["#t"],
      mentions: ["bob@providera.test"],
      summary: "S",
    });
    expect(message.title).toBeUndefined();
    expect(await stored(b, alice, m)).toEqual(message);

    const expectError = async (ws: typeof aWs, id: string, status: number) => {
      const err = await ws.ofType("error");
      expect({ id: err.correlationId, status: (err.data as { status: number }).status }).toEqual({
        id,
        status,
      });
    };
    send(aWs, "cli_none", {});
    await expectError(aWs, "cli_none", 400);
    send(aWs, "cli_cover", { attachments: [] });
    await expectError(aWs, "cli_cover", 400);
    send(bWs, "cli_bob", {});
    await expectError(bWs, "cli_bob", 403);
    send(aWs, "cli_missing", { messageId: "msg_missing" });
    await expectError(aWs, "cli_missing", 404);
    expect(await stored(b, alice, m)).toEqual(message);
    aWs.close();
    bWs.close();
  });
});
