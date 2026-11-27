/**
 * Direct-message send and real-time tests (spec §7.4, §8.3): the single
 * signed send path, inbox-only storage (no sender copy), the §8.3 `{dmId}`
 * check (400 on mismatch, inbox poisoning), idempotency, `dm.message` delivery
 * to the recipient only, and DM targets over the WebSocket.
 *
 * Real sockets and signed HTTP over `helpers/ws-harness.ts`.
 */
import { describe, expect, test } from "bun:test";
import { deriveDmId } from "@forumall/shared";

import { sendDm } from "./helpers/dm-harness.ts";
import {
  DOMAIN,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-dms-send-");

describe("DM send + inbox-only storage (§7.4, §8.3)", () => {
  test("alice→bob lands in bob's inbox; alice's inbox is empty (no sender copy)", async () => {
    const b = boot("dm-basic");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const res = await sendDm(b, alice, dmId, "hey bob", "cmsg_1");
    expect(res.status).toBe(201);
    const stored = (await res.json()) as { id: string; author: string; content: { text: string } };
    expect(stored.author).toBe(alice.actor);
    expect(stored.content.text).toBe("hey bob");

    // bob reads his inbox → sees the message.
    const bobHist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    expect(bobHist.status).toBe(200);
    const bobItems = ((await bobHist.json()) as { items: { id: string; author: string }[] }).items;
    expect(bobItems.length).toBe(1);
    expect(bobItems[0]?.id).toBe(stored.id);
    expect(bobItems[0]?.author).toBe(alice.actor);

    // alice reads the conversation → 200 with her SENT message (broadened read:
    // no sender copy is stored, but the read returns rows she authored that sit
    // in bob's inbox, §7.4).
    const aliceHist = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages`);
    expect(aliceHist.status).toBe(200);
    const aliceItems = ((await aliceHist.json()) as { items: { id: string; author: string }[] })
      .items;
    expect(aliceItems.length).toBe(1);
    expect(aliceItems[0]?.id).toBe(stored.id);
    expect(aliceItems[0]?.author).toBe(alice.actor);
  });

  test("dmId mismatch → 400, nothing stored (inbox poisoning blocked)", async () => {
    const b = boot("dm-mismatch");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");

    // dmId derived for a DIFFERENT pair (bob, carol) — author alice is not in it.
    const wrongDmId = deriveDmId(bob.actor, carol.actor);
    const res = await sendDm(b, alice, wrongDmId, "poison", "cmsg_x");
    expect(res.status).toBe(400);

    // A totally random dm_<hex> → also 400.
    const randomDmId = `dm_${"a".repeat(64)}`;
    const res2 = await sendDm(b, alice, randomDmId, "poison2", "cmsg_y");
    expect(res2.status).toBe(400);

    // Nothing landed: bob and carol have no conversation rows from alice.
    // (bob's inbox for the bob/carol dmId is unknown to bob anyway, but check
    // the (alice,bob) conversation is empty: bob has no inbox for it.)
    const ab = deriveDmId(alice.actor, bob.actor);
    const bobHist = await signedReq(b, bob, "GET", `/api/dms/${ab}/messages`);
    expect(bobHist.status).toBe(404);
  });

  /**
   * The §7.1 idempotency guard `(owner, dmId, author, clientMessageId)` is what
   * makes a client RETRY safe: a send that committed but whose acknowledgement
   * was lost (aborted fetch / network drop / 5xx) is re-sent under the SAME id,
   * and the recipient must end up with exactly ONE message — the first one,
   * unchanged — rather than a duplicate delivery.
   */
  test("idempotency: same clientMessageId twice → one stored row, the FIRST message", async () => {
    const b = boot("dm-idempotent");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const r1 = await sendDm(b, alice, dmId, "once", "cmsg_dup");
    expect(r1.status).toBe(201);
    const first = (await r1.json()) as { id: string; createdAt: string };

    // The retry replays the same key. Different text on purpose: the guard must
    // return the STORED message, not re-store or overwrite it with the re-send.
    const r2 = await sendDm(b, alice, dmId, "once-again", "cmsg_dup");
    // Duplicate returns the existing stored message (200), unchanged.
    expect(r2.status).toBe(200);
    const second = (await r2.json()) as {
      id: string;
      createdAt: string;
      content: { text: string };
    };
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.content.text).toBe("once");

    // Exactly one row in bob's inbox, still carrying the first delivery's content.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
      .items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(first.id);
    expect(items[0]?.content.text).toBe("once");

    // …and the author's broadened read (§7.4) sees the single message too — no
    // second copy surfaces on the sender's side either.
    const mine = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages`);
    const mineItems = ((await mine.json()) as { items: { id: string }[] }).items;
    expect(mineItems.length).toBe(1);
    expect(mineItems[0]?.id).toBe(first.id);
  });
});

describe("DM real-time delivery (§7.4)", () => {
  test("bob receives dm.message with a cursor; alice (also connected) does NOT", async () => {
    const b = boot("dm-realtime");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const aConn = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);

    const res = await sendDm(b, alice, dmId, "ping", "cmsg_rt");
    expect(res.status).toBe(201);

    const evt = await bConn.ofType("dm.message");
    const data = evt.data as {
      dmId: string;
      cursor?: string;
      message: { id: string; author: string; content: { text: string }; clientMessageId?: string };
    };
    expect(data.dmId).toBe(dmId);
    expect(typeof data.cursor).toBe("string");
    expect((data.cursor as string).length).toBeGreaterThan(0);
    expect(data.message.author).toBe(alice.actor);
    expect(data.message.content.text).toBe("ping");
    expect(data.message.clientMessageId).toBe("cmsg_rt");

    // alice (the sender) must NOT receive dm.message — only the recipient's
    // inbox stored it, so only bob is notified.
    await expect(await aConn.none((f) => f.type === "dm.message", 300)).toBe(true);

    aConn.close();
    bConn.close();
  });

  test("WS subscribe to a dm_ target: participant acks, non-participant refused as not_found", async () => {
    const b = boot("dm-subscribe");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // Land a message so bob has a conversation row (participant).
    await sendDm(b, alice, dmId, "hi", "cmsg_s");

    const bConn = await connectAuthenticated(b, bob);
    bConn.send({
      id: "b_sub",
      type: "subscribe",
      data: { channels: [dmId] },
    });
    const ack = await bConn.ofType("subscribed");
    expect((ack.data as { channels: string[] }).channels).toEqual([dmId]);

    // carol is not a participant of (alice,bob) → refused like a missing
    // target (§7.1, §11.3).
    const cConn = await connectAuthenticated(b, carol);
    cConn.send({
      id: "c_sub",
      type: "subscribe",
      data: { channels: [dmId] },
    });
    const err = await cConn.ofType("error");
    expect(err.correlationId).toBe("c_sub");
    expect(err.data).toMatchObject({
      code: "not_found",
      status: 404,
      details: { channels: [dmId] },
    });

    bConn.close();
    cConn.close();
  });
});

describe("ignored conversation rows over WS (§7.4 pointer hygiene)", () => {
  test("WS subscribe and typing against a row whose counterparty does not derive its dmId are refused", async () => {
    const b = boot("dm-ws-ignored-row");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    // dmId of alice↔carol, but the stored counterparty is bob.
    const dmId = deriveDmId(alice.actor, `carol@${DOMAIN}`);
    b.db.sqlite
      .query(
        "INSERT INTO dm_conversations (owner, dm_id, counterparty, updated_at, last_message_seq) VALUES ('alice', ?, ?, ?, 0)",
      )
      .run(dmId, bob.actor, Date.now());

    const aConn = await connectAuthenticated(b, alice);
    const bConn = await connectAuthenticated(b, bob);

    aConn.send({
      id: "a_sub",
      type: "subscribe",
      data: { channels: [dmId] },
    });
    // Both are refused as for an unknown dmId (§7.4 "Non-participants answer as unknown").
    const subErr = await aConn.ofType("error");
    expect(subErr.data).toMatchObject({ code: "not_found", details: { channels: [dmId] } });

    aConn.send({ id: "a_typ", type: "typing.start", data: { channelId: dmId } });
    const typErr = await aConn.ofType("error");
    expect((typErr.data as { code: string }).code).toBe("not_found");
    aConn.send({ id: "a_stop", type: "typing.stop", data: { channelId: dmId } });
    const stopErr = await aConn.next((f) => f.correlationId === "a_stop");
    expect((stopErr.data as { code: string }).code).toBe("not_found");
    await expect(await bConn.none((f) => f.type === "dm.typing", 300)).toBe(true);

    aConn.close();
    bConn.close();
  });
});
