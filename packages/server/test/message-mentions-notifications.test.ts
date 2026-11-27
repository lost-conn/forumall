/**
 * `mentions` drive the notification feed (§5.3 *Mentions*, §10.1):
 *
 *  - when a message carries `mentions`, the users it mentions are exactly those
 *    actors and its text is not parsed — `mentions: []` mentions nobody;
 *  - without `mentions`, mentions are parsed from the text;
 *  - the usual recipient rules still apply to a listed actor: never the author,
 *    only a local user, only one who can read the channel;
 *  - both create transports (REST `POST …/messages` and WS `message.create`)
 *    reach the same rule;
 *  - edits never create notification entries (§7.1, §10.1), whatever mention
 *    they add, over REST `PATCH` and WS `message.update`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageSchema, rfc3339Timestamp } from "@forumall/shared";

import { listNotifications } from "../src/provider/notifications-feed.ts";
import {
  type Booted,
  DOMAIN,
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
  tmp = mkdtempSync(join(tmpdir(), "forumall-mentions-notif-"));
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

const text = (t: string) => ({ mime: "text/plain", text: t });
const messagesPath = (ids: Ids) => `/api/groups/${ids.groupId}/channels/${ids.channelId}/messages`;

/** A group-tier channel owned by `alice`, with `bob` and `carol` as members. */
async function setup(name: string) {
  const b = boot(name);
  const alice = await registerUserWithKey(b, "alice");
  const bob = await registerUserWithKey(b, "bob");
  const carol = await registerUserWithKey(b, "carol");
  const dave = await registerUserWithKey(b, "dave"); // not a member: cannot read
  const ids = await makeGroupChannel(b, alice, "group");
  addMember(b, ids.groupId, bob, "member");
  addMember(b, ids.groupId, carol, "member");
  return { b, alice, bob, carol, dave, ids };
}

async function create(b: Booted, who: Signer, ids: Ids, body: unknown) {
  const res = await signedReq(b, who, "POST", messagesPath(ids), body);
  expect(res.status).toBe(201);
  return MessageSchema.parse(await res.json());
}

/** The `mention` entries in `handle`'s feed, as their source message ids. */
function mentionsOf(b: Booted, handle: string): string[] {
  return listNotifications(b.db, handle)
    .items.filter((n) => n.type === "mention")
    .map((n) => n.sourceMessageId);
}

describe("mentions replace text parsing (§5.3, §10.1)", () => {
  test("REST: the listed actors are mentioned and the text is not parsed", async () => {
    const { b, alice, bob, ids } = await setup("rest-listed");
    const msg = await create(b, alice, ids, {
      content: text("hey @carol"),
      mentions: [bob.actor],
    });
    expect(msg.mentions).toEqual([bob.actor]);
    expect(mentionsOf(b, "bob")).toEqual([msg.id]);
    expect(mentionsOf(b, "carol")).toEqual([]);
  });

  test("REST: mentions: [] mentions nobody, whatever the text names", async () => {
    const { b, alice, ids } = await setup("rest-empty");
    const msg = await create(b, alice, ids, { content: text("@bob @carol"), mentions: [] });
    expect(msg.mentions).toEqual([]);
    expect(mentionsOf(b, "bob")).toEqual([]);
    expect(mentionsOf(b, "carol")).toEqual([]);
  });

  test("REST: without mentions, the text is parsed", async () => {
    const { b, alice, ids } = await setup("rest-parsed");
    const msg = await create(b, alice, ids, { content: text("hi @bob") });
    expect(msg.mentions).toBeUndefined();
    expect(mentionsOf(b, "bob")).toEqual([msg.id]);
    expect(mentionsOf(b, "carol")).toEqual([]);
  });

  test("a listed actor still has to be another local user who can read the channel", async () => {
    const { b, alice, bob, dave, ids } = await setup("rest-rules");
    const msg = await create(b, alice, ids, {
      content: text("no names here"),
      mentions: [alice.actor, dave.actor, `ghost@${DOMAIN}`, "bob@elsewhere.test", bob.actor],
    });
    expect(mentionsOf(b, "bob")).toEqual([msg.id]);
    expect(mentionsOf(b, "alice")).toEqual([]); // the author
    expect(mentionsOf(b, "dave")).toEqual([]); // cannot read the channel
    expect(listNotifications(b.db, "ghost").items).toEqual([]); // no such user
  });

  test("WS message.create follows the same rule", async () => {
    const { b, alice, bob, ids } = await setup("ws-listed");
    const conn = await connectAuthenticated(b, alice);
    await subscribe(conn, ids.channelId);
    conn.send({
      id: "cmd_listed",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: { ...ids, content: text("hey @carol"), mentions: [bob.actor] },
    });
    const listed = MessageSchema.parse(
      ((await conn.ofType("message.created")).data as { message: unknown }).message,
    );
    conn.send({
      id: "cmd_empty",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: { ...ids, content: text("@bob"), mentions: [] },
    });
    await conn.ofType("message.created");
    expect(mentionsOf(b, "bob")).toEqual([listed.id]);
    expect(mentionsOf(b, "carol")).toEqual([]);
    conn.close();
  });
});

describe("edits never create notification entries (§7.1, §10.1)", () => {
  test("REST PATCH adding a mention, by text or by mentions, notifies no one", async () => {
    const { b, alice, carol, ids } = await setup("edit-rest");
    const msg = await create(b, alice, ids, { content: text("plain") });
    const patch = await signedReq(b, alice, "PATCH", `${messagesPath(ids)}/${msg.id}`, {
      content: text("now with @bob"),
      mentions: [carol.actor],
    });
    expect(patch.status).toBe(200);
    const edited = MessageSchema.parse(await patch.json());
    expect(edited.mentions).toEqual([carol.actor]);
    expect(listNotifications(b.db, "bob").items).toEqual([]);
    expect(listNotifications(b.db, "carol").items).toEqual([]);
  });

  test("WS message.update adding a mention notifies no one", async () => {
    const { b, alice, bob, ids } = await setup("edit-ws");
    const msg = await create(b, alice, ids, { content: text("plain") });
    const conn = await connectAuthenticated(b, alice);
    await subscribe(conn, ids.channelId);
    conn.send({
      id: "cmd_edit",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: { ...ids, messageId: msg.id, content: text("hi @carol"), mentions: [bob.actor] },
    });
    const updated = await conn.ofType("message.updated");
    expect(updated.correlationId).toBe("cmd_edit");
    expect(listNotifications(b.db, "bob").items).toEqual([]);
    expect(listNotifications(b.db, "carol").items).toEqual([]);
    conn.close();
  });
});
