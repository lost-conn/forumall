/**
 * The field rules a message create shares with an edit (§5.3, §5.8, §7.1):
 *
 *  - the §5.8 *Checks on attachments in a message* (`checkMessageAttachments`):
 *    a hosted attachment must be the author's stored upload with matching
 *    `mime` / `size` / `hash` and is stored as the provider's record; a local
 *    author's attachments must all be hosted; a remote author's other
 *    attachments lose any `expiresAt`, on them and their thumbnails;
 *  - `mentions` must be canonical actors and are stored (absent stays absent);
 *  - an `article` stores `title` / `summary` / `cover`, and a `cover` must name
 *    one of its attachments; other types ignore the article fields;
 *  - a DM create gets the same attachment and mentions checks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Attachment, MessageSchema, deriveDmId } from "@forumall/shared";
import { eq } from "drizzle-orm";

import { openDb } from "../src/db/index.ts";
import { migrate, migrations, runMigrations } from "../src/db/migrate.ts";
import { type DmMessageRow, type MessageRow, dmMessages, messages } from "../src/db/schema.ts";
import { rowToDmMessage } from "../src/provider/dms.ts";
import { checkMessageAttachments } from "../src/provider/message-attachments.ts";
import { rowToMessage } from "../src/provider/messages.ts";
import { hostedAttachment } from "./helpers/attachments.ts";
import {
  type Booted,
  boot as bootIn,
  makeGroupChannel,
  registerUserWithKey,
  signedReq,
} from "./helpers/provider-harness.ts";

let tmp: string;
const booted: Booted[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-msg-create-fields-"));
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
const REMOTE = "carol@elsewhere.test";

const external: Attachment = {
  id: "att_remote",
  mime: "video/mp4",
  url: "https://cdn.elsewhere.test/m/v.mp4",
  size: 100,
  expiresAt: "2099-01-01T00:00:00Z",
  thumbnail: {
    id: "att_poster",
    mime: "image/jpeg",
    url: "https://cdn.elsewhere.test/m/p.jpg",
    size: 10,
    expiresAt: "2099-01-01T00:00:00Z",
  },
};

describe("checkMessageAttachments (§5.8)", () => {
  test("a remote author's attachment it does not host: kept, without expiresAt", async () => {
    const b = boot("check-remote");
    const outcome = checkMessageAttachments(b.db, b.config, REMOTE, [external]);
    const { expiresAt: _e, thumbnail, ...rest } = external;
    const { expiresAt: _t, ...thumb } = thumbnail as Attachment;
    expect(outcome).toEqual({ attachments: [{ ...rest, thumbnail: thumb }] });
  });

  test("a hosted attachment is checked whoever the author is", async () => {
    const b = boot("check-hosted");
    const alice = await registerUserWithKey(b, "alice");
    const mine = hostedAttachment(b, alice);
    const check = (author: string, a: Attachment) =>
      checkMessageAttachments(b.db, b.config, author, [a]);

    expect(check(alice.actor, { ...mine, filename: "x", expiresAt: external.expiresAt })).toEqual({
      attachments: [mine],
    });
    // Another actor (remote or local) naming alice's upload, by id or by url.
    expect(check(REMOTE, mine).error).toContain("uploaded by another user");
    expect(check(REMOTE, { ...mine, id: "att_other" }).error).toContain("not an upload");
    // An unknown upload at this provider's media URL.
    const unknown = { ...mine, id: "att_nope", url: mine.url.replace(mine.id, "att_nope") };
    expect(check(REMOTE, unknown).error).toContain("not an upload");
    expect(check(alice.actor, { ...mine, hash: "sha-256:AAAA" }).error).toContain("hash");
    // A local author's attachment must be hosted here.
    expect(check(alice.actor, external).error).toContain("not hosted here");
  });

  test("checked here as well as by the request schemas: https only, no nested thumbnail", async () => {
    const b = boot("check-remote-shape");
    const check = (a: Attachment) => checkMessageAttachments(b.db, b.config, REMOTE, [a]).error;
    const thumb = external.thumbnail;
    if (thumb === undefined) throw new Error("the external sample has a thumbnail");
    expect(check({ ...external, url: "http://cdn.elsewhere.test/m/v.mp4" })).toContain("https");
    expect(check({ ...external, thumbnail: { ...thumb, url: "ftp://x.test/p.jpg" } })).toContain(
      "https",
    );
    expect(check({ ...external, thumbnail: { ...thumb, thumbnail: thumb } })).toContain(
      "must not itself carry a thumbnail",
    );
  });
});

describe("channel create (§5.3, §5.8, §7.1)", () => {
  test("stores mentions and the article fields; checks attachments, mentions and cover", async () => {
    const b = boot("create");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const ids = await makeGroupChannel(b, alice);
    const path = `/api/groups/${ids.groupId}/channels/${ids.channelId}/messages`;
    const img = hostedAttachment(b, alice);
    const post = (body: unknown) => signedReq(b, alice, "POST", path, body);

    const article = await post({
      type: "article",
      content: text("body"),
      attachments: [{ ...img, expiresAt: external.expiresAt }],
      mentions: ["bob@providera.test"],
      title: "T",
      summary: "S",
      cover: img.id,
    });
    expect(article.status).toBe(201);
    expect(MessageSchema.parse(await article.json())).toMatchObject({
      attachments: [img],
      mentions: ["bob@providera.test"],
      title: "T",
      summary: "S",
      cover: img.id,
    });

    // Other types ignore the article fields (a bad cover included).
    const plain = await post({ content: text("x"), title: "T", cover: "att_none" });
    expect(plain.status).toBe(201);
    const stored = MessageSchema.parse(await plain.json());
    expect(stored.title).toBeUndefined();
    expect(stored.cover).toBeUndefined();
    expect(stored.mentions).toBeUndefined();

    const rejected: unknown[] = [
      { type: "article", content: text("x"), cover: "att_none" },
      { type: "article", content: text("x"), attachments: [img], cover: "att_none" },
      { content: text("x"), attachments: [hostedAttachment(b, bob)] },
      { content: text("x"), attachments: [external] },
      { content: text("x"), mentions: ["Bob@providera.test"] },
    ];
    for (const body of rejected) {
      const res = await post(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
  });
});

describe("migrations 0039 / 0040 (mentions, article fields, DM tags)", () => {
  test("add the columns; existing rows read back without the new fields", () => {
    const db = openDb(join(tmp, "m0039.sqlite"));
    const ids = ["0039_messages_mentions_article", "0040_dm_messages_tags_mentions"];
    runMigrations(
      db,
      migrations.filter((m) => !ids.includes(m.id)),
    );
    const body = JSON.stringify(text("old"));
    db.sqlite
      .query(
        "INSERT INTO messages (id, channel_id, group_id, author, type, content, attachments, tags, seq, created_at, edit_until) VALUES ('msg_c', 'chn_x', 'grp_x', 'alice@providera.test', 'article', ?, '[]', '[]', 1, 1, 1)",
      )
      .run(body);
    db.sqlite
      .query(
        "INSERT INTO dm_messages (id, dm_id, owner, author, content, attachments, seq, created_at, edit_until) VALUES ('msg_d', 'dm_x', 'alice', 'bob@providera.test', ?, '[]', 2, 1, 1)",
      )
      .run(body);
    expect(migrate(db)).toEqual(ids);

    const channel = rowToMessage(
      db.drizzle.select().from(messages).where(eq(messages.id, "msg_c")).all()[0] as MessageRow,
    );
    expect(channel.mentions).toBeUndefined();
    expect(channel.title).toBeUndefined();
    expect(channel.cover).toBeUndefined();
    const dm = rowToDmMessage(
      db.drizzle
        .select()
        .from(dmMessages)
        .where(eq(dmMessages.id, "msg_d"))
        .all()[0] as DmMessageRow,
    );
    expect(dm.tags).toBeUndefined();
    expect(dm.mentions).toBeUndefined();
    expect(migrate(db)).toEqual([]);
    db.sqlite.close();
  });
});

describe("DM create (§5.8, §7.4)", () => {
  test("checks attachments and mentions, and stores mentions", async () => {
    const b = boot("dm-create");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const path = `/api/federation/dms/${dmId}/messages`;
    const img = hostedAttachment(b, alice);
    const send = (key: string, body: Record<string, unknown>) =>
      signedReq(b, alice, "POST", path, { clientMessageId: key, content: text("x"), ...body });

    const ok = await send("k_ok", { attachments: [img], mentions: ["bob@providera.test"] });
    expect(ok.status).toBe(201);
    expect(MessageSchema.parse(await ok.json())).toMatchObject({
      attachments: [img],
      mentions: ["bob@providera.test"],
    });
    for (const [key, body] of [
      ["k_foreign", { attachments: [hostedAttachment(b, bob)] }],
      ["k_external", { attachments: [external] }],
      ["k_mention", { mentions: ["bob@ProviderA.test"] }],
    ] as const) {
      expect((await send(key, body)).status).toBe(400);
    }
  });
});
