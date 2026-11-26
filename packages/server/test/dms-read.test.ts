/**
 * Direct-message read tests (spec §7.4): conversation listing, participant-only
 * reads (404 for a non-participant), the broadened read of sent messages, and
 * DM delete (tombstone on the stored copy, §7.1).
 *
 * Real sockets and signed HTTP over `helpers/ws-harness.ts`.
 */
import { describe, expect, test } from "bun:test";
import { deriveDmId } from "@forumall/shared";

import { sendDm } from "./helpers/dm-harness.ts";
import { registerUserWithKey, signedReq, useWsBoot } from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-dms-read-");

describe("DM listing + participation (§7.4)", () => {
  test("GET /api/me/dms lists bob's conversation with alice (participants + lastMessage)", async () => {
    const b = boot("dm-list");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    await sendDm(b, alice, dmId, "last words", "cmsg_l");

    const res = await signedReq(b, bob, "GET", "/api/me/dms");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        id: string;
        participants: string[];
        lastMessage?: { content: { text: string } };
        updatedAt: string;
      }[];
    };
    expect(body.items.length).toBe(1);
    const conv = body.items[0];
    expect(conv?.id).toBe(dmId);
    expect(conv?.participants).toContain(bob.actor);
    expect(conv?.participants).toContain(alice.actor);
    expect(conv?.lastMessage?.content.text).toBe("last words");

    // alice keeps no sender COPY, but her home provider (this one) records a
    // conversation POINTER (§7.4) so the conversation she started lists for her,
    // previewing her own last sent message.
    const aliceList = await signedReq(b, alice, "GET", "/api/me/dms");
    const aliceItems = (
      (await aliceList.json()) as {
        items: { id: string; lastMessage?: { author: string; content: { text: string } } }[];
      }
    ).items;
    expect(aliceItems.length).toBe(1);
    expect(aliceItems[0]?.id).toBe(dmId);
    expect(aliceItems[0]?.lastMessage?.author).toBe(alice.actor);
  });

  test("non-participant carol reading /api/dms/{dmId}/messages → 404", async () => {
    const b = boot("dm-nonparticipant");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    await sendDm(b, alice, dmId, "private", "cmsg_p");

    const res = await signedReq(b, carol, "GET", `/api/dms/${dmId}/messages`);
    expect(res.status).toBe(404);
  });
});

describe("DM broadened read: sender can read back their sent messages (§7.4)", () => {
  test("both A and B see the full conversation (sent ∪ received), ordered by seq", async () => {
    const b = boot("dm-broadened-both");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice → bob, then bob → alice (interleaved authorship).
    const s1 = await sendDm(b, alice, dmId, "from alice 1", "c1");
    const s2 = await sendDm(b, bob, dmId, "from bob 1", "c2");
    const s3 = await sendDm(b, alice, dmId, "from alice 2", "c3");
    const id1 = ((await s1.json()) as { id: string }).id;
    const id2 = ((await s2.json()) as { id: string }).id;
    const id3 = ((await s3.json()) as { id: string }).id;

    // alice reads (forward = chronological): sees all three, hers + bob's.
    const aRes = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages?direction=forward`);
    expect(aRes.status).toBe(200);
    const aItems = ((await aRes.json()) as { items: { id: string; author: string }[] }).items;
    expect(aItems.map((m) => m.id)).toEqual([id1, id2, id3]);
    expect(aItems.map((m) => m.author)).toEqual([alice.actor, bob.actor, alice.actor]);

    // bob reads (forward): sees the same three in the same seq order.
    const bRes = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages?direction=forward`);
    expect(bRes.status).toBe(200);
    const bItems = ((await bRes.json()) as { items: { id: string; author: string }[] }).items;
    expect(bItems.map((m) => m.id)).toEqual([id1, id2, id3]);
  });

  test("a sender who has ONLY sent (no received) can read their sent message back", async () => {
    const b = boot("dm-broadened-onlysent");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await sendDm(b, alice, dmId, "only sent", "c_only");
    const id = ((await sent.json()) as { id: string }).id;

    // alice has no inbox row of her own for dmId, but is the counterparty of
    // bob's inbox row → participant; the read returns her sent message.
    const res = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: { id: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(id);
  });

  test("a genuine non-participant still gets 404", async () => {
    const b = boot("dm-broadened-nonparticipant");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    await sendDm(b, alice, dmId, "private", "c_priv");

    const res = await signedReq(b, carol, "GET", `/api/dms/${dmId}/messages`);
    expect(res.status).toBe(404);
  });

  test("replies read is scoped the same way (sent replies show too)", async () => {
    const b = boot("dm-broadened-replies");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    // alice sends a parent, then alice replies to it (the reply is authored by
    // alice and stored in bob's inbox — no sender copy).
    const parent = await sendDm(b, alice, dmId, "parent", "c_parent");
    const parentId = ((await parent.json()) as { id: string }).id;
    const reply = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "c_reply",
      content: { mime: "text/plain", text: "my reply" },
      reference: { type: "reply", id: parentId },
    });
    const replyId = ((await reply.json()) as { id: string }).id;

    // alice lists the replies to her parent → sees her own sent reply.
    const res = await signedReq(b, alice, "GET", `/api/dms/${dmId}/messages/${parentId}/replies`);
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: { id: string }[] }).items;
    expect(items.map((m) => m.id)).toEqual([replyId]);
  });
});

describe("DM delete (§7.1 tombstone on the stored copy)", () => {
  test("bob deletes a received DM → tombstone (deletedAt set, content cleared)", async () => {
    const b = boot("dm-delete");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const sent = await sendDm(b, alice, dmId, "delete me", "cmsg_d");
    const messageId = ((await sent.json()) as { id: string }).id;

    const del = await signedReq(b, bob, "DELETE", `/api/dms/${dmId}/messages/${messageId}`);
    expect(del.status).toBe(204);

    // The tombstone remains in history: same id, content cleared, deletedAt set.
    const hist = await signedReq(b, bob, "GET", `/api/dms/${dmId}/messages`);
    const items = (
      (await hist.json()) as {
        items: { id: string; deletedAt?: string; content: { text: string } }[];
      }
    ).items;
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe(messageId);
    expect(typeof items[0]?.deletedAt).toBe("string");
    expect(items[0]?.content.text).toBe("");
  });
});
