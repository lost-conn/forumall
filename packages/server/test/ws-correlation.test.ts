/**
 * §7.1 / §7.3 `correlationId` on fanned-out events: when a WS command causes a
 * channel fan-out (`message.create` → `message.created`, `message.update` →
 * `message.updated`, `message.delete` → `message.deleted`, `reaction.add` →
 * `reaction.added`, `reaction.remove` → `reaction.removed`), only the
 * requesting connection's copy carries the
 * command's `id`. Every other subscriber — the author's other connections
 * included — gets an uncorrelated copy of the same event.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WsEnvelope, rfc3339Timestamp } from "@forumall/shared";

import {
  type Booted,
  type WsClient,
  addMember,
  boot as bootIn,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  subscribe,
} from "./helpers/provider-harness.ts";

let tmp: string;
const booted: Booted[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-ws-correlation-"));
});
afterAll(() => {
  for (const b of booted) b.server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

const text = (t: string) => ({ mime: "text/plain", text: t });

/** The `message` of a `message.created` / `message.updated` frame. */
const messageOf = (frame: WsEnvelope) => (frame.data as { message: { id: string } }).message;

describe("correlationId reaches only the requesting connection", () => {
  test("message and reaction events: correlated for the sender, plain for the rest", async () => {
    const b = bootIn(tmp, "ws-correlation");
    booted.push(b);
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const ids = await makeGroupChannel(b, alice);
    addMember(b, ids.groupId, bob, "member");

    // Alice on two devices, bob on one, all subscribed.
    const aliceSender = await connectAuthenticated(b, alice);
    const aliceOther = await connectAuthenticated(b, alice);
    const bobConn = await connectAuthenticated(b, bob);
    const all: WsClient[] = [aliceSender, aliceOther, bobConn];
    for (const conn of all) await subscribe(conn, ids.channelId);

    aliceSender.send({
      id: "cmd_create",
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: { ...ids, clientMessageId: "cmsg_corr", content: text("hello") },
    });
    const [mine, otherDevice, bobs] = await Promise.all(
      all.map((conn) => conn.ofType("message.created")),
    );
    expect(mine?.correlationId).toBe("cmd_create");
    expect(otherDevice?.correlationId).toBeUndefined();
    expect(bobs?.correlationId).toBeUndefined();
    // Same event everywhere: one frame id, one message.
    expect(otherDevice?.id).toBe(mine?.id);
    expect(bobs?.id).toBe(mine?.id);
    const message = messageOf(mine as WsEnvelope);
    expect(messageOf(otherDevice as WsEnvelope)).toEqual(message);
    expect(messageOf(bobs as WsEnvelope)).toEqual(message);

    aliceSender.send({
      id: "cmd_edit",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: { ...ids, messageId: message.id, content: text("hello, edited") },
    });
    const [myEdit, otherEdit, bobEdit] = await Promise.all(
      all.map((conn) => conn.ofType("message.updated")),
    );
    expect(myEdit?.correlationId).toBe("cmd_edit");
    expect(otherEdit?.correlationId).toBeUndefined();
    expect(bobEdit?.correlationId).toBeUndefined();
    expect(messageOf(otherEdit as WsEnvelope).id).toBe(message.id);

    // Reactions and the delete correlate the same way.
    const reactionTarget = { ...ids, messageId: message.id, key: "heart", unicode: "❤️" };
    const cases = [
      { id: "cmd_react", type: "reaction.add", event: "reaction.added", data: reactionTarget },
      {
        id: "cmd_unreact",
        type: "reaction.remove",
        event: "reaction.removed",
        data: { ...ids, messageId: message.id, key: "heart" },
      },
      {
        id: "cmd_delete",
        type: "message.delete",
        event: "message.deleted",
        data: { ...ids, messageId: message.id },
      },
    ];
    for (const { id, type, event, data } of cases) {
      aliceSender.send({ id, type, ts: rfc3339Timestamp(), data });
      const [own, other, bob] = await Promise.all(all.map((conn) => conn.ofType(event)));
      expect({ event, correlationId: own?.correlationId }).toEqual({ event, correlationId: id });
      expect({ event, correlationId: other?.correlationId }).toEqual({
        event,
        correlationId: undefined,
      });
      expect({ event, correlationId: bob?.correlationId }).toEqual({
        event,
        correlationId: undefined,
      });
      expect(other?.id).toBe(own?.id);
      expect(bob?.data).toEqual(own?.data);
    }

    for (const conn of all) conn.close();
  });
});
