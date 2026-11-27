/**
 * §7.4 DM typing over the WebSocket. The target is the `dmId` in `channelId`
 * (`{ "type": "typing.start", "data": { "channelId": "dm_…" } }`, the schema's
 * only target field), and the provider emits `dm.typing { dmId, user, state }`
 * to the counterparty:
 *
 *  - any participant may type (no group permission); a successful start is not
 *    acknowledged and the typer gets no echo;
 *  - a `typing.stop` ends the actor's typing on every connection of theirs; one
 *    with no active start is a no-op that sends nothing;
 *  - a non-participant's start or stop is `not_found`, correlated;
 *  - auto-expiry and a typing connection closing deliver a `stop`, but only
 *    once no other connection of the actor's still types there.
 *
 * Both actors are local, so participation is decided by derivation and no
 * message needs to exist (§7.4 "Non-participants answer as unknown").
 */
import { describe, expect, test } from "bun:test";
import { type WsEnvelope, deriveDmId, rfc3339Timestamp } from "@forumall/shared";

import {
  type Booted,
  type Signer,
  type WsClient,
  connectAuthenticated,
  registerUserWithKey,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-dm-typing-");

/** Short enough to watch an auto-expiry happen within a test. */
const TYPING_TIMEOUT_MS = 300;

const isDmTyping = (f: WsEnvelope) => f.type === "dm.typing";
const correlated = (id: string) => (f: WsEnvelope) => f.correlationId === id;

function typing(conn: WsClient, id: string, type: "typing.start" | "typing.stop", target: string) {
  conn.send({ id, type, ts: rfc3339Timestamp(), data: { channelId: target } });
}

interface Fixture {
  b: Booted;
  alice: Signer;
  bob: Signer;
  carol: Signer;
  dmId: string;
  aliceConn: WsClient;
  bobConn: WsClient;
}

/** alice and bob converse (no messages yet); carol is a third local user. */
async function fixture(name: string): Promise<Fixture> {
  const b = boot(name, undefined, { TYPING_TIMEOUT_MS: String(TYPING_TIMEOUT_MS) });
  const alice = await registerUserWithKey(b, "alice");
  const bob = await registerUserWithKey(b, "bob");
  const carol = await registerUserWithKey(b, "carol");
  const aliceConn = await connectAuthenticated(b, alice);
  const bobConn = await connectAuthenticated(b, bob);
  const dmId = deriveDmId(alice.actor, bob.actor);
  return { b, alice, bob, carol, dmId, aliceConn, bobConn };
}

describe("DM typing targets the dmId in channelId (§7.4)", () => {
  test("a start reaches the counterparty as dm.typing, unacknowledged and with no echo; a stop ends it", async () => {
    const f = await fixture("dm-typing-spec-form");

    typing(f.aliceConn, "ts1", "typing.start", f.dmId);
    const start = await f.bobConn.next(isDmTyping);
    expect(start.data).toEqual({ dmId: f.dmId, user: f.alice.actor, state: "start" });
    expect(start.correlationId).toBeUndefined();
    // No acknowledgement and no echo to the typer.
    expect(
      await f.aliceConn.none((frame) => frame.correlationId === "ts1" || isDmTyping(frame)),
    ).toBe(true);

    typing(f.aliceConn, "ts2", "typing.stop", f.dmId);
    const stop = await f.bobConn.next(isDmTyping);
    expect(stop.data).toEqual({ dmId: f.dmId, user: f.alice.actor, state: "stop" });
    expect(await f.aliceConn.none(correlated("ts2"))).toBe(true);
  });

  test("a typing.stop with no active start is a no-op: nothing to the counterparty or the requester", async () => {
    const f = await fixture("dm-typing-noop-stop");

    typing(f.aliceConn, "never", "typing.stop", f.dmId);
    expect(await f.bobConn.none(isDmTyping)).toBe(true);
    expect(await f.aliceConn.none(correlated("never"))).toBe(true);

    // A second stop after the first one ended the start is a no-op as well.
    typing(f.aliceConn, "start", "typing.start", f.dmId);
    await f.bobConn.next(isDmTyping);
    typing(f.aliceConn, "stop1", "typing.stop", f.dmId);
    expect((await f.bobConn.next(isDmTyping)).data).toMatchObject({ state: "stop" });
    typing(f.aliceConn, "stop2", "typing.stop", f.dmId);
    expect(await f.bobConn.none(isDmTyping)).toBe(true);
    expect(await f.aliceConn.none(correlated("stop2"))).toBe(true);
  });

  test("a non-participant's start and stop are both not_found, correlated, and reach no one", async () => {
    const f = await fixture("dm-typing-non-participant");
    const carolConn = await connectAuthenticated(f.b, f.carol);

    typing(carolConn, "c_start", "typing.start", f.dmId);
    expect((await carolConn.next(correlated("c_start"))).data).toMatchObject({
      code: "not_found",
      status: 404,
    });
    typing(carolConn, "c_stop", "typing.stop", f.dmId);
    expect((await carolConn.next(correlated("c_stop"))).data).toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(await f.aliceConn.none(isDmTyping)).toBe(true);
    expect(await f.bobConn.none(isDmTyping)).toBe(true);
  });

  test("a stop from another connection of the actor ends the actor's typing", async () => {
    const f = await fixture("dm-typing-other-conn");
    const aliceOther = await connectAuthenticated(f.b, f.alice);

    typing(f.aliceConn, "start", "typing.start", f.dmId);
    await f.bobConn.next(isDmTyping);
    typing(aliceOther, "stop", "typing.stop", f.dmId);
    expect((await f.bobConn.next(isDmTyping)).data).toMatchObject({ state: "stop" });
    // The start is gone on every connection: the first connection's stop is a no-op.
    typing(f.aliceConn, "stop-again", "typing.stop", f.dmId);
    expect(await f.bobConn.none(isDmTyping)).toBe(true);
  });

  test("auto-expiry and a closing connection deliver a stop once no connection of the actor still types", async () => {
    const f = await fixture("dm-typing-expiry-close");
    const aliceOther = await connectAuthenticated(f.b, f.alice);

    // Expiry: no refreshing start within the timeout → an automatic stop.
    typing(f.aliceConn, "start", "typing.start", f.dmId);
    await f.bobConn.next(isDmTyping);
    expect((await f.bobConn.next(isDmTyping, TYPING_TIMEOUT_MS * 5)).data).toMatchObject({
      state: "stop",
    });

    // Close: both connections type; closing one leaves the actor typing, closing
    // the other delivers the stop.
    typing(f.aliceConn, "s1", "typing.start", f.dmId);
    typing(aliceOther, "s2", "typing.start", f.dmId);
    await f.bobConn.next(isDmTyping);
    await f.bobConn.next(isDmTyping);
    f.aliceConn.close();
    expect(await f.bobConn.none(isDmTyping, TYPING_TIMEOUT_MS / 3)).toBe(true);
    aliceOther.close();
    expect((await f.bobConn.next(isDmTyping)).data).toMatchObject({
      user: f.alice.actor,
      state: "stop",
    });
  });

  test("the non-spec `dmId` field is not a target: a frame without channelId is bad_request", async () => {
    const f = await fixture("dm-typing-legacy-field");

    f.aliceConn.send({ id: "legacy", type: "typing.start", data: { dmId: f.dmId } });
    expect((await f.aliceConn.next(correlated("legacy"))).data).toMatchObject({
      code: "bad_request",
    });
    expect(await f.bobConn.none(isDmTyping)).toBe(true);
  });
});
