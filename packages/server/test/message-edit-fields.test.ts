/**
 * Which `MessageUpdate` fields this provider applies (spec §7.1 Editing). The
 * schema accepts any edit carrying at least one field (content, attachments,
 * tags, mentions, title, summary, cover); this provider applies only `content`
 * so far. Pinned here, on every edit path (WS `message.update`, channel PATCH,
 * DM PATCH, federation DM PATCH):
 *
 *  - an edit carrying no field → 400 (§7.1);
 *  - an edit carrying only fields other than `content` → 400 with
 *    {@link CONTENT_ONLY_EDIT_MESSAGE}, and the message is unchanged. That
 *    includes §7.1's 400 for article-only fields sent to a non-article;
 *  - an edit carrying `content` plus other fields still edits the content.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageSchema, deriveDmId, rfc3339Timestamp } from "@forumall/shared";

import { CONTENT_ONLY_EDIT_MESSAGE } from "../src/http/message-mutations.ts";
import {
  type Booted,
  type Signer,
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

/** Edits the schema accepts but this provider does not apply (no `content`). */
const NON_CONTENT_EDITS: Record<string, unknown>[] = [
  { tags: ["#a"] },
  { mentions: ["bob@providera.test"] },
  { attachments: [] },
  { title: "T", summary: null },
];

async function problemDetail(res: Response): Promise<string> {
  return ((await res.json()) as { detail?: string }).detail ?? "";
}

/** A channel with one message by `author`; returns its ids and the PATCH path. */
async function channelMessage(b: Booted, author: Signer) {
  const ids = await makeGroupChannel(b, author);
  const base = `/api/groups/${ids.groupId}/channels/${ids.channelId}/messages`;
  const res = await signedReq(b, author, "POST", base, { content: text("orig") });
  expect(res.status).toBe(201);
  const messageId = ((await res.json()) as { id: string }).id;
  return { ...ids, messageId, path: `${base}/${messageId}` };
}

async function currentText(b: Booted, who: Signer, groupId: string, channelId: string) {
  const res = await signedReq(
    b,
    who,
    "GET",
    `/api/groups/${groupId}/channels/${channelId}/messages`,
  );
  const items = ((await res.json()) as { items: { content: { text: string } }[] }).items;
  return items.map((m) => m.content.text);
}

describe("channel PATCH (§7.1): content-only edits", () => {
  test("no field → 400; non-content fields → 400 + unchanged; content + others → 200", async () => {
    const b = boot("rest-fields");
    const alice = await registerUserWithKey(b, "alice");
    const m = await channelMessage(b, alice);

    expect((await signedReq(b, alice, "PATCH", m.path, {})).status).toBe(400);
    for (const body of NON_CONTENT_EDITS) {
      const res = await signedReq(b, alice, "PATCH", m.path, body);
      expect(res.status).toBe(400);
      expect(await problemDetail(res)).toBe(CONTENT_ONLY_EDIT_MESSAGE);
    }
    expect(await currentText(b, alice, m.groupId, m.channelId)).toEqual(["orig"]);

    const ok = await signedReq(b, alice, "PATCH", m.path, { content: text("new"), tags: ["#a"] });
    expect(ok.status).toBe(200);
    expect(MessageSchema.parse(await ok.json()).content.text).toBe("new");
  });
});

describe("WS message.update (§7.1): content-only edits", () => {
  test("no field → 400; non-content fields → 400 with the reason, correlated", async () => {
    const b = boot("ws-fields");
    const alice = await registerUserWithKey(b, "alice");
    const m = await channelMessage(b, alice);
    const target = { groupId: m.groupId, channelId: m.channelId, messageId: m.messageId };
    const ws = await connectAuthenticated(b, alice);
    await subscribe(ws, m.channelId);

    const send = (id: string, data: Record<string, unknown>) =>
      ws.send({ id, type: "message.update", ts: rfc3339Timestamp(), data: { ...target, ...data } });

    send("cli_none", {});
    const none = await ws.ofType("error");
    expect(none.correlationId).toBe("cli_none");
    expect((none.data as { status: number }).status).toBe(400);

    send("cli_tags", { tags: ["#a"] });
    const tags = await ws.ofType("error");
    expect(tags.correlationId).toBe("cli_tags");
    expect(tags.data as { status: number; message: string }).toMatchObject({
      status: 400,
      message: CONTENT_ONLY_EDIT_MESSAGE,
    });
    expect(await currentText(b, alice, m.groupId, m.channelId)).toEqual(["orig"]);
    ws.close();
  });
});

describe("DM PATCH (§7.4, §8.3): content-only edits", () => {
  for (const route of ["/api/dms", "/api/federation/dms"]) {
    test(`${route}: no field → 400; non-content fields → 400; content → 200`, async () => {
      const b = boot(`dm-fields-${route.replaceAll("/", "-")}`);
      const alice = await registerUserWithKey(b, "alice");
      const bob = await registerUserWithKey(b, "bob");
      const dmId = deriveDmId(alice.actor, bob.actor);
      const sent = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
        clientMessageId: "cmsg_1",
        content: text("orig"),
      });
      expect(sent.status).toBe(201);
      const path = `${route}/${dmId}/messages/${((await sent.json()) as { id: string }).id}`;

      expect((await signedReq(b, alice, "PATCH", path, {})).status).toBe(400);
      for (const body of NON_CONTENT_EDITS) {
        const res = await signedReq(b, alice, "PATCH", path, body);
        expect(res.status).toBe(400);
        expect(await problemDetail(res)).toBe(CONTENT_ONLY_EDIT_MESSAGE);
      }

      const ok = await signedReq(b, alice, "PATCH", path, { content: text("new"), tags: ["#a"] });
      expect(ok.status).toBe(200);
      expect(MessageSchema.parse(await ok.json()).content.text).toBe("new");
    });
  }
});
