/**
 * DM message edits (spec §7.1 *Editing* applied to the stored inbox copy,
 * §7.4, §8.3) on `PATCH /api/dms/{dmId}/messages/{id}` and the federation
 * ingest `PATCH /api/federation/dms/{dmId}/messages/{id}`:
 *
 *  - each `MessageUpdate` field present replaces the stored value (`content`,
 *    `attachments` in full, `tags`, `mentions`); a DM is never an `article`,
 *    so the article fields are ignored, and an edit carrying only them is a 400;
 *  - the §5.8 attachment checks and the canonical-mentions rule of a create;
 *  - 404 (no such message) and 403 (not the author) before the body is judged;
 *  - an edit of a DM held by a REMOTE counterparty is forwarded to that
 *    provider in full, which checks it (as a remote author's) and answers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, MessageSchema, deriveDmId } from "@forumall/shared";

import { hostedAttachment } from "./helpers/attachments.ts";
import { registerAt, signedReqAt } from "./helpers/cross-provider.ts";
import {
  type Booted,
  type Signer,
  boot as bootIn,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
} from "./helpers/provider-harness.ts";
import { type Federation, startFederation } from "./helpers/two-provider.ts";

let tmp: string;
const booted: Booted[] = [];
const feds: Federation[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-msg-edit-dm-"));
});
afterAll(() => {
  for (const b of booted) b.server.stop(true);
  for (const f of feds) f.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function boot(name: string): Booted {
  const b = bootIn(tmp, name);
  booted.push(b);
  return b;
}

const text = (t: string) => ({ mime: "text/plain", text: t });

/** A message from `items` without its history `cursor`. */
function historyMessage(items: { id: string; cursor?: string }[], id: string): Message {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error("message not in history");
  const { cursor: _cursor, ...message } = found;
  return MessageSchema.parse(message);
}

for (const route of ["/api/dms", "/api/federation/dms"]) {
  describe(`${route} PATCH (§7.1, §7.4)`, () => {
    test("each field replaces the stored value; article fields ignored; 404/403 before 400", async () => {
      const b = boot(`dm-${route.replaceAll("/", "-")}`);
      const alice = await registerUserWithKey(b, "alice");
      const bob = await registerUserWithKey(b, "bob");
      const dmId = deriveDmId(alice.actor, bob.actor);
      const first = hostedAttachment(b, alice);
      const second = hostedAttachment(b, alice);
      const bobs = hostedAttachment(b, bob);
      const sent = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
        clientMessageId: "cmsg_1",
        content: text("orig"),
        attachments: [first],
        mentions: ["bob@providera.test"],
      });
      expect(sent.status).toBe(201);
      const messageId = ((await sent.json()) as { id: string }).id;
      const path = `${route}/${dmId}/messages/${messageId}`;
      const bobWs = await connectAuthenticated(b, bob);

      const edit = async (who: Signer, body: unknown, status = 200, at = path) => {
        const res = await signedReq(b, who, "PATCH", at, body);
        const json = await res.json();
        expect({ body, status: res.status }).toEqual({ body, status });
        return status === 200 ? MessageSchema.parse(json) : null;
      };

      let msg = await edit(alice, { tags: ["#t"] });
      expect(msg).toMatchObject({
        content: text("orig"),
        attachments: [first],
        tags: ["#t"],
        mentions: ["bob@providera.test"],
      });
      const evt = await bobWs.next(
        (f) =>
          f.type === "dm.message" &&
          (f.data as { message?: { editedAt?: string } }).message?.editedAt !== undefined,
      );
      expect((evt.data as { message: unknown }).message).toEqual(msg);

      msg = await edit(alice, { attachments: [] });
      expect(msg?.attachments).toEqual([]);
      msg = await edit(alice, { attachments: [second], mentions: [], content: text("new") });
      expect(msg).toMatchObject({ attachments: [second], mentions: [], content: text("new") });

      // A DM is a `message`: article fields alone are a 400, else ignored.
      await edit(alice, { title: "T" }, 400);
      await edit(alice, { title: "T", summary: null, cover: null }, 400);
      msg = await edit(alice, { tags: [], title: "T", cover: second.id });
      expect(msg?.title).toBeUndefined();
      expect(msg?.cover).toBeUndefined();
      expect(msg?.tags).toBeUndefined();

      // The create's checks on the edited fields.
      await edit(alice, { attachments: [bobs] }, 400);
      await edit(alice, { attachments: [{ ...second, size: 1 }] }, 400);
      await edit(alice, { mentions: ["Bob@providera.test"] }, 400);
      await edit(alice, {}, 400);

      // 404 / 403 whatever the body.
      const missing = path.replace(messageId, "msg_missing");
      for (const body of [{}, { title: "T" }]) {
        await edit(alice, body, 404, missing);
        // bob holds the message in his inbox but did not write it.
        if (route === "/api/dms") await edit(bob, body, 403);
      }

      const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
      const items = ((await hist.json()) as { items: { id: string }[] }).items;
      expect(historyMessage(items, messageId)).toEqual(msg as Message);
      bobWs.close();
    });
  });
}

describe("DM edit forwarded to a remote counterparty's provider (§7.4, §8.3)", () => {
  test("the whole MessageUpdate reaches the holder, which checks it as a remote author's", async () => {
    const fed = startFederation(tmp, {
      domainA: "aedit.test",
      domainB: "bedit.test",
      envA: { FEDERATION_INSECURE_LOCALHOST: "1" },
      envB: { FEDERATION_INSECURE_LOCALHOST: "1" },
    });
    feds.push(fed);
    const alice = await registerAt(fed.a.base, "aedit.test", "alice");
    const bob = await registerAt(fed.b.base, "bedit.test", "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    // alice uploads at her home provider (a), then delivers to bob's (b).
    const att = hostedAttachment(fed.a, alice);
    const att2 = hostedAttachment(fed.a, alice, { filename: "two.png" });
    const expiring = { ...att, expiresAt: "2099-01-01T00:00:00Z" };

    const sent = await signedReqAt(
      fed.b.base,
      "bedit.test",
      alice,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "x1", content: text("hi"), attachments: [expiring] },
    );
    expect(sent.status).toBe(201);
    const created = MessageSchema.parse(await sent.json());
    // b does not host it and alice is remote there: kept, minus `expiresAt`.
    expect(created.attachments).toEqual([att]);
    // bob replies so alice holds a conversation row on a (needed to forward).
    const reply = await signedReqAt(
      fed.a.base,
      "aedit.test",
      bob,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      { clientMessageId: "y1", content: text("hey") },
    );
    expect(reply.status).toBe(201);

    const path = `/api/dms/${dmId}/messages/${created.id}`;
    const edit = (body: unknown) =>
      signedReqAt(fed.a.base, "aedit.test", alice, "PATCH", path, body);

    const ok = await edit({
      attachments: [{ ...att2, thumbnail: { ...att, expiresAt: "2099-01-01T00:00:00Z" } }],
      tags: ["#x"],
      mentions: ["bob@bedit.test"],
      title: "ignored",
    });
    expect(ok.status).toBe(200);
    const edited = MessageSchema.parse(await ok.json());
    expect(edited).toMatchObject({
      content: text("hi"),
      attachments: [{ ...att2, thumbnail: att }],
      tags: ["#x"],
      mentions: ["bob@bedit.test"],
    });
    expect(edited.title).toBeUndefined();

    // b's own rules, answered through a: article-only, non-https, empty.
    for (const body of [
      { title: "T" },
      { attachments: [{ ...att, url: "http://aedit.test/api/media/x" }] },
      {},
    ]) {
      expect((await edit(body)).status).toBe(400);
    }

    const hist = await signedReqAt(
      fed.b.base,
      "bedit.test",
      bob,
      "GET",
      `/api/dms/${dmId}/messages`,
    );
    const items = ((await hist.json()) as { items: { id: string }[] }).items;
    expect(historyMessage(items, created.id)).toEqual(edited);
  });
});
