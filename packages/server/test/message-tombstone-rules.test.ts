/**
 * §7.1 "Edits and deletes of a tombstone" and the reaction no-op rules, over
 * both transports, with a watching subscriber to prove what is (not) fanned
 * out:
 *
 *  - an edit of a tombstone is `404` / `not_found` (step 3, before the author
 *    check), and leaves it unchanged; an edit body that is not a JSON object is
 *    `400` before even that (step 1);
 *  - a repeated delete is `204` over REST and fans out nothing; over WebSocket
 *    the requesting connection alone gets a `message.deleted` with the
 *    command's `correlationId` and no `cursor`; the permission check (step 4)
 *    still comes first;
 *  - a reaction add on a tombstone is `404` / `not_found` and stores nothing,
 *    its body judged only after that; a remove on one proceeds (a held
 *    reaction is removed and fanned out);
 *  - a repeated add changes nothing and fans out nothing (REST returns the
 *    existing `Reaction` with `200`; WebSocket answers the requester alone); a
 *    remove that removes nothing is `204` and fans out nothing.
 */
import { describe, expect, test } from "bun:test";
import { type WsEnvelope, rfc3339Timestamp } from "@forumall/shared";

import {
  type Booted,
  type Signer,
  type WsClient,
  addMember,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  signedRawReq,
  signedReq,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-tombstone-rules-");

interface Fixture {
  b: Booted;
  alice: Signer;
  bob: Signer;
  groupId: string;
  channelId: string;
  messageId: string;
  /** bob, subscribed: sees whatever is fanned out to the channel. */
  watcher: WsClient;
}

/** alice owns a public channel with one message of hers; bob watches it. */
async function fixture(name: string): Promise<Fixture> {
  const b = boot(name);
  const alice = await registerUserWithKey(b, "alice");
  const bob = await registerUserWithKey(b, "bob");
  const { groupId, channelId } = await makeGroupChannel(b, alice);
  addMember(b, groupId, bob, "member");
  const res = await signedReq(b, alice, "POST", messagesPath({ groupId, channelId }), {
    content: { mime: "text/plain", text: "hello" },
  });
  expect(res.status).toBe(201);
  const messageId = ((await res.json()) as { id: string }).id;
  const watcher = await connectAuthenticated(b, bob);
  await subscribe(watcher, channelId);
  return { b, alice, bob, groupId, channelId, messageId, watcher };
}

const messagesPath = (f: { groupId: string; channelId: string }) =>
  `/api/groups/${f.groupId}/channels/${f.channelId}/messages`;
const messagePath = (f: Fixture) => `${messagesPath(f)}/${f.messageId}`;
const reactionPath = (f: Fixture, key: string) => `${messagePath(f)}/reactions/${key}`;

const ids = (f: Fixture) => ({ groupId: f.groupId, channelId: f.channelId });
const ofType = (type: string) => (frame: WsEnvelope) => frame.type === type;
const correlated = (id: string) => (frame: WsEnvelope) => frame.correlationId === id;

function command(conn: WsClient, id: string, type: string, data: Record<string, unknown>): void {
  conn.send({ id, type, ts: rfc3339Timestamp(), data });
}

/** The channel's stored copy of the fixture's message, read over REST. */
async function storedMessage(f: Fixture): Promise<Record<string, unknown>> {
  const res = await signedReq(f.b, f.alice, "GET", messagesPath(f));
  const items = ((await res.json()) as { items: Record<string, unknown>[] }).items;
  const found = items.find((m) => m.id === f.messageId);
  if (!found) throw new Error("message missing from history");
  return found;
}

/** Tombstone the fixture's message over REST, consuming the watcher's event. */
async function tombstone(f: Fixture): Promise<string> {
  expect((await signedReq(f.b, f.alice, "DELETE", messagePath(f))).status).toBe(204);
  await f.watcher.next(ofType("message.deleted"));
  const deletedAt = (await storedMessage(f)).deletedAt;
  expect(typeof deletedAt).toBe("string");
  return deletedAt as string;
}

async function problemCode(res: Response): Promise<string> {
  return ((await res.json()) as { errorCode: string }).errorCode;
}

describe("edits and deletes of a tombstone (§7.1)", () => {
  test("an edit of a tombstone is 404 over REST and not_found over WebSocket, for the author too", async () => {
    const f = await fixture("tomb-edit");
    const deletedAt = await tombstone(f);
    const edit = { content: { mime: "text/plain", text: "resurrected" } };

    const rest = await signedReq(f.b, f.alice, "PATCH", messagePath(f), edit);
    expect(rest.status).toBe(404);
    expect(await problemCode(rest)).toBe("not_found");
    // Step 3 comes before the author check: a non-author gets the same 404.
    const other = await signedReq(f.b, f.bob, "PATCH", messagePath(f), edit);
    expect(other.status).toBe(404);

    const conn = await connectAuthenticated(f.b, f.alice);
    command(conn, "edit", "message.update", { ...ids(f), messageId: f.messageId, ...edit });
    const err = await conn.next(correlated("edit"));
    expect(err.type).toBe("error");
    expect(err.data).toMatchObject({ code: "not_found", status: 404 });

    const stored = await storedMessage(f);
    expect(stored.deletedAt).toBe(deletedAt);
    expect(stored.editedAt).toBeUndefined();
    expect(await f.watcher.none(ofType("message.updated"))).toBe(true);
  });

  test("a repeated delete over REST is 204, leaves the tombstone as it was, and fans out nothing", async () => {
    const f = await fixture("tomb-delete-rest");
    const deletedAt = await tombstone(f);

    expect((await signedReq(f.b, f.alice, "DELETE", messagePath(f))).status).toBe(204);
    expect(await f.watcher.none(ofType("message.deleted"))).toBe(true);
    expect((await storedMessage(f)).deletedAt).toBe(deletedAt);
  });

  test("a repeated delete over WebSocket answers the requester alone, correlated and without a cursor", async () => {
    const f = await fixture("tomb-delete-ws");
    const deletedAt = await tombstone(f);
    const requester = await connectAuthenticated(f.b, f.alice);
    const otherDevice = await connectAuthenticated(f.b, f.alice);
    await subscribe(requester, f.channelId);
    await subscribe(otherDevice, f.channelId);

    command(requester, "del", "message.delete", { ...ids(f), messageId: f.messageId });
    const answer = await requester.next(correlated("del"));
    expect(answer.type).toBe("message.deleted");
    expect(answer.data).toEqual({
      groupId: f.groupId,
      channelId: f.channelId,
      messageId: f.messageId,
      deletedAt,
    });
    expect(await requester.none(ofType("message.deleted"))).toBe(true);
    expect(await otherDevice.none(ofType("message.deleted"))).toBe(true);
    expect(await f.watcher.none(ofType("message.deleted"))).toBe(true);
    expect((await storedMessage(f)).deletedAt).toBe(deletedAt);
  });

  test("the permission check precedes the repeated-delete answer: a non-author non-moderator gets 403", async () => {
    const f = await fixture("tomb-delete-403");
    await tombstone(f);

    const rest = await signedReq(f.b, f.bob, "DELETE", messagePath(f));
    expect(rest.status).toBe(403);
    const conn = await connectAuthenticated(f.b, f.bob);
    command(conn, "del", "message.delete", { ...ids(f), messageId: f.messageId });
    expect((await conn.next(correlated("del"))).data).toMatchObject({ code: "forbidden" });
  });

  test("an edit body that is not a JSON object is 400 before visibility, the message and permission (step 1)", async () => {
    const f = await fixture("tomb-edit-not-object");
    await tombstone(f);
    // A channel in a private group bob is not in: it answers as missing (404).
    const hidden = await makeGroupChannel(f.b, f.alice, { group: "private", channel: "public" });
    const targets = [
      ["tombstone", messagePath(f)],
      ["missing message", `${messagesPath(f)}/msg_nope`],
      ["hidden channel", `${messagesPath(hidden)}/msg_nope`],
    ] as const;
    const notObjects = [
      ["a JSON string", JSON.stringify("x")],
      ["a JSON array", "[]"],
      ["JSON null", "null"],
      ["not JSON", "not json"],
    ] as const;
    for (const [where, path] of targets) {
      // A well-formed edit is 404 here, so the 400 below comes from step 1.
      const wellFormed = await signedReq(f.b, f.bob, "PATCH", path, {
        content: { mime: "text/plain", text: "x" },
      });
      expect(`${where}: ${wellFormed.status}`).toBe(`${where}: 404`);
      for (const [what, body] of notObjects) {
        const res = await signedRawReq(f.b, f.bob, "PATCH", path, body);
        expect(`${where}, ${what}: ${res.status}`).toBe(`${where}, ${what}: 400`);
        expect(await problemCode(res)).toBe("bad_request");
      }
    }
    expect(await f.watcher.none(ofType("message.updated"))).toBe(true);
  });
});

describe("reactions on a tombstone (§7.1 order of checks)", () => {
  test("an add is 404 over REST and not_found over WebSocket, stores nothing, and its body is judged after", async () => {
    const f = await fixture("tomb-react-add");
    await tombstone(f);

    const rest = await signedReq(f.b, f.bob, "PUT", reactionPath(f, "heart"), { unicode: "❤️" });
    expect(rest.status).toBe(404);
    expect(await problemCode(rest)).toBe("not_found");
    // A body breaking the schema is step 5: the tombstone's 404 comes first.
    const badBody = await signedReq(f.b, f.bob, "PUT", reactionPath(f, "heart"), { unicode: 7 });
    expect(badBody.status).toBe(404);

    const conn = await connectAuthenticated(f.b, f.bob);
    command(conn, "rx", "reaction.add", { ...ids(f), messageId: f.messageId, key: "heart" });
    const err = await conn.next(correlated("rx"));
    expect(err.type).toBe("error");
    expect(err.data).toMatchObject({ code: "not_found", status: 404 });

    const list = await signedReq(f.b, f.bob, "GET", `${messagePath(f)}/reactions`);
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
    expect(await f.watcher.none(ofType("reaction.added"))).toBe(true);
  });

  test("a remove on a tombstone proceeds: a held reaction is removed and fanned out, then a repeat is a no-op", async () => {
    const f = await fixture("tomb-react-remove");
    expect((await signedReq(f.b, f.bob, "PUT", reactionPath(f, "heart"))).status).toBe(201);
    await f.watcher.next(ofType("reaction.added"));
    await tombstone(f);

    expect((await signedReq(f.b, f.bob, "DELETE", reactionPath(f, "heart"))).status).toBe(204);
    const removed = await f.watcher.next(ofType("reaction.removed"));
    expect(removed.data).toMatchObject({
      messageId: f.messageId,
      key: "heart",
      author: f.bob.actor,
    });

    expect((await signedReq(f.b, f.bob, "DELETE", reactionPath(f, "heart"))).status).toBe(204);
    expect(await f.watcher.none(ofType("reaction.removed"))).toBe(true);
  });
});

describe("reaction no-ops answer the requester only (§7.1)", () => {
  test("a repeated REST add returns the existing Reaction unchanged (200) and fans out nothing", async () => {
    const f = await fixture("react-repeat-rest");
    const first = await signedReq(f.b, f.alice, "PUT", reactionPath(f, "heart"), {
      unicode: "❤️",
    });
    expect(first.status).toBe(201);
    const original = (await first.json()) as Record<string, unknown>;
    await f.watcher.next(ofType("reaction.added"));

    const repeat = await signedReq(f.b, f.alice, "PUT", reactionPath(f, "heart"), {
      unicode: "💖",
      image: "https://example.test/heart.png",
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(original);
    expect(await f.watcher.none(ofType("reaction.added"))).toBe(true);
  });

  test("a repeated WebSocket add sends the existing Reaction to the requesting connection alone", async () => {
    const f = await fixture("react-repeat-ws");
    const requester = await connectAuthenticated(f.b, f.alice);
    const otherDevice = await connectAuthenticated(f.b, f.alice);
    await subscribe(requester, f.channelId);
    await subscribe(otherDevice, f.channelId);
    const target = { ...ids(f), messageId: f.messageId, key: "heart" };

    command(requester, "rx1", "reaction.add", { ...target, unicode: "❤️" });
    const added = await requester.next(correlated("rx1"));
    const reaction = (added.data as { reaction: Record<string, unknown> }).reaction;
    await otherDevice.next(ofType("reaction.added"));
    await f.watcher.next(ofType("reaction.added"));

    command(requester, "rx2", "reaction.add", { ...target, unicode: "💖" });
    const again = await requester.next(correlated("rx2"));
    expect(again.type).toBe("reaction.added");
    expect(again.data).toEqual({ groupId: f.groupId, channelId: f.channelId, reaction });
    expect(await requester.none(ofType("reaction.added"))).toBe(true);
    expect(await otherDevice.none(ofType("reaction.added"))).toBe(true);
    expect(await f.watcher.none(ofType("reaction.added"))).toBe(true);
  });

  test("a REST remove that removes nothing is 204 and fans out nothing", async () => {
    const f = await fixture("react-noop-rest");
    expect((await signedReq(f.b, f.alice, "DELETE", reactionPath(f, "heart"))).status).toBe(204);
    expect(await f.watcher.none(ofType("reaction.removed"))).toBe(true);
  });
});
