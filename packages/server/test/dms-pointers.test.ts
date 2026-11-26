/**
 * Direct-message conversation pointer tests (spec §7.4, §8): delivery `to`,
 * `PUT /api/me/dms/{dmId}` input and federation-policy hardening, and the
 * conversation preview ordered by provider-recorded time.
 *
 * Real sockets and signed HTTP over `helpers/ws-harness.ts`.
 */
import { describe, expect, test } from "bun:test";
import { deriveDmId } from "@forumall/shared";

import { getDmConversationRow, storeDmMessage, upsertDmPointer } from "../src/provider/dms.ts";
import { signedProviderFetch } from "../src/provider/federation/http.ts";
import { sendDm } from "./helpers/dm-harness.ts";
import {
  type Booted,
  DOMAIN,
  type Signer,
  registerUserWithKey,
  signedReq,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-dms-ptr-");

describe("DM delivery `to` + conversation pointers (§7.4)", () => {
  test("delivery naming `to` is accepted; a `to` that does not match {dmId} → 400", async () => {
    const b = boot("dm-to");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await registerUserWithKey(b, "carol");
    const dmId = deriveDmId(alice.actor, bob.actor);

    const ok = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "to-1",
      to: bob.actor,
      content: { mime: "text/plain", text: "hi bob" },
    });
    expect(ok.status).toBe(201);

    // carol is a real local user, but {dmId} is alice↔bob → refused.
    const bad = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
      clientMessageId: "to-2",
      to: `carol@${DOMAIN}`,
      content: { mime: "text/plain", text: "misaddressed" },
    });
    expect(bad.status).toBe(400);
  });

  test("PUT /api/me/dms/{dmId} records a pointer to a remote conversation", async () => {
    const b = boot("dm-pointer");
    const alice = await registerUserWithKey(b, "alice");
    const remote = "dave@remote.example";
    const dmId = deriveDmId(alice.actor, remote);
    const sent = {
      id: "msg_remote1",
      author: alice.actor,
      type: "message",
      content: { mime: "text/plain", text: "hello over there" },
      attachments: [],
      createdAt: "2026-02-01T10:00:00Z",
      metadata: [],
    };

    const put = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: remote,
      lastMessage: sent,
    });
    expect(put.status).toBe(200);
    const conv = (await put.json()) as { id: string; participants: string[] };
    expect(conv.id).toBe(dmId);
    expect(conv.participants).toEqual([alice.actor, remote]);

    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    const items = ((await list.json()) as { items: { id: string; lastMessage?: { id: string } }[] })
      .items;
    expect(items.map((i) => i.id)).toEqual([dmId]);
    expect(items[0]?.lastMessage?.id).toBe("msg_remote1");

    // {dmId} not derived from (caller, with) → 400.
    const mismatch = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: "erin@remote.example",
    });
    expect(mismatch.status).toBe(400);
    // A preview authored by someone else → 400.
    const forged = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: remote,
      lastMessage: { ...sent, author: remote },
    });
    expect(forged.status).toBe(400);
  });
});

describe("DM conversation pointers: input + federation policy hardening (§7.4, §8)", () => {
  test("PUT rejects a URI or non-canonical `with` (400, never 500)", async () => {
    const b = boot("dm-pointer-canon");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, "dave@remote.example");

    for (const bad of [
      "https://remote.example/u/dave",
      "DAVE@remote.example",
      "dave@Remote.Example",
    ]) {
      const res = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, { with: bad });
      expect(res.status).toBe(400);
    }
    // Nothing was recorded.
    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test("upsertDmPointer never rewrites the counterparty of an existing row to another actor", async () => {
    const b = boot("dm-pointer-no-overwrite");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    await sendDm(b, bob, dmId, "hi alice", "cmsg_x"); // alice's inbox row, counterparty = bob

    // Even if a differently-spelled counterparty reached the upsert, the
    // verified participant on the existing row is kept, in canonical form.
    upsertDmPointer(b.db, alice.actor, dmId, bob.actor.toUpperCase());
    expect(getDmConversationRow(b.db, "alice", dmId, DOMAIN)?.counterparty).toBe(bob.actor);
  });

  test("PUT refuses a counterparty on a deny-listed provider (403)", async () => {
    const b = boot("dm-pointer-deny", undefined, { FEDERATION_DENY: "evil.example" });
    const alice = await registerUserWithKey(b, "alice");
    const remote = "x@evil.example";
    const dmId = deriveDmId(alice.actor, remote);

    const res = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, { with: remote });
    expect(res.status).toBe(403);
    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test("outbound provider-signed calls never reach a deny-listed provider", async () => {
    const b = boot("dm-outbound-deny", undefined, { FEDERATION_DENY: "evil.example" });
    let calls = 0;
    const stub = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as Parameters<typeof signedProviderFetch>[3];

    const res = await signedProviderFetch(
      b.db,
      b.config,
      { method: "PUT", url: "https://evil.example/api/federation/dms/x/reactions/y" },
      stub,
    );
    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });
});

describe("DM conversation preview: newer by provider-recorded time (§7.4)", () => {
  const REMOTE = "dave@remote.example";

  /** A pointer preview alice "sent", with a client-chosen `createdAt`. */
  function preview(alice: Signer, id: string, createdAt: string) {
    return {
      id,
      author: alice.actor,
      type: "message",
      content: { mime: "text/plain", text: id },
      attachments: [],
      createdAt,
      metadata: [],
    };
  }

  /** Store a message from the remote party in alice's inbox; return its id. */
  function receive(b: Booted, dmId: string, text: string): string {
    return storeDmMessage(b.db, b.config, {
      owner: "alice",
      dmId,
      author: REMOTE,
      content: { mime: "text/plain", text },
    }).message.id;
  }

  async function previewId(b: Booted, alice: Signer, dmId: string): Promise<string | undefined> {
    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    const items = ((await list.json()) as { items: { id: string; lastMessage?: { id: string } }[] })
      .items;
    return items.find((i) => i.id === dmId)?.lastMessage?.id;
  }

  async function putPointer(b: Booted, alice: Signer, dmId: string, lastMessage?: unknown) {
    const res = await signedReq(b, alice, "PUT", `/api/me/dms/${dmId}`, {
      with: REMOTE,
      ...(lastMessage !== undefined ? { lastMessage } : {}),
    });
    expect(res.status).toBe(200);
  }

  /** Let the clock tick so successive provider store times are distinct. */
  const tick = () => Bun.sleep(3);

  test("a forged far-future preview createdAt doesn't beat a later-stored received message", async () => {
    const b = boot("dm-preview-forged");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);

    await putPointer(b, alice, dmId, preview(alice, "msg_forged", "2099-01-01T00:00:00Z"));
    await tick();
    const received = receive(b, dmId, "newer, really");
    expect(await previewId(b, alice, dmId)).toBe(received);
  });

  test("a preview stored later wins even with an old createdAt; a PUT without lastMessage changes nothing", async () => {
    const b = boot("dm-preview-touch");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);

    receive(b, dmId, "first");
    await tick();
    // Stored after the received message, though its (client) createdAt is old.
    await putPointer(b, alice, dmId, preview(alice, "msg_sent", "2020-01-01T00:00:00Z"));
    expect(await previewId(b, alice, dmId)).toBe("msg_sent");
    await tick();
    await putPointer(b, alice, dmId); // touch only
    expect(await previewId(b, alice, dmId)).toBe("msg_sent");

    await tick();
    const received = receive(b, dmId, "second");
    expect(await previewId(b, alice, dmId)).toBe(received);
    await tick();
    await putPointer(b, alice, dmId); // touch only — bumps updatedAt, not the preview time
    expect(await previewId(b, alice, dmId)).toBe(received);
  });

  test("re-PUTting the same preview keeps its original store time", async () => {
    const b = boot("dm-preview-replay");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);

    const old = preview(alice, "msg_old", "2026-01-01T00:00:00Z");
    await putPointer(b, alice, dmId, old);
    const storedAt = getDmConversationRow(b.db, "alice", dmId, DOMAIN)?.lastSentAt;
    await tick();
    const reply = receive(b, dmId, "newer reply");
    await tick();
    // A retried/replayed PUT of the same message must not re-stamp it.
    await putPointer(b, alice, dmId, old);
    expect(getDmConversationRow(b.db, "alice", dmId, DOMAIN)?.lastSentAt).toBe(storedAt);
    expect(await previewId(b, alice, dmId)).toBe(reply);

    // A genuinely new message is stamped now and wins.
    await tick();
    await putPointer(b, alice, dmId, preview(alice, "msg_new", "2026-01-01T00:00:00Z"));
    expect(await previewId(b, alice, dmId)).toBe("msg_new");
  });

  test("on a tie the received message wins", async () => {
    const b = boot("dm-preview-tie");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);

    const received = receive(b, dmId, "received");
    await putPointer(b, alice, dmId, preview(alice, "msg_sent", "2099-01-01T00:00:00Z"));
    // Force identical provider store times.
    b.db.sqlite
      .query(
        "UPDATE dm_conversations SET last_sent_at = (SELECT created_at FROM dm_messages WHERE id = ?) WHERE owner = 'alice' AND dm_id = ?",
      )
      .run(received, dmId);
    expect(await previewId(b, alice, dmId)).toBe(received);
  });

  test("a legacy preview with no store time loses to any received message", async () => {
    const b = boot("dm-preview-legacy");
    const alice = await registerUserWithKey(b, "alice");
    const dmId = deriveDmId(alice.actor, REMOTE);
    const clearTime = () =>
      b.db.sqlite
        .query("UPDATE dm_conversations SET last_sent_at = NULL WHERE owner = 'alice'")
        .run();

    // With an empty inbox the legacy preview is still shown.
    await putPointer(b, alice, dmId, preview(alice, "msg_legacy", "2099-01-01T00:00:00Z"));
    clearTime();
    expect(getDmConversationRow(b.db, "alice", dmId, DOMAIN)?.lastSentAt).toBeNull();
    expect(await previewId(b, alice, dmId)).toBe("msg_legacy");

    // Once anything is received, the received message wins.
    const received = receive(b, dmId, "received");
    expect(await previewId(b, alice, dmId)).toBe(received);
  });

  test("a forged preview time doesn't reorder the conversation list", async () => {
    const b = boot("dm-preview-order");
    const alice = await registerUserWithKey(b, "alice");
    const forgedDm = deriveDmId(alice.actor, REMOTE);
    const otherRemote = "erin@remote.example";
    const otherDm = deriveDmId(alice.actor, otherRemote);

    await putPointer(b, alice, forgedDm, preview(alice, "msg_forged", "2099-01-01T00:00:00Z"));
    await tick();
    storeDmMessage(b.db, b.config, {
      owner: "alice",
      dmId: otherDm,
      author: otherRemote,
      content: { mime: "text/plain", text: "latest activity" },
    });
    const list = await signedReq(b, alice, "GET", "/api/me/dms");
    const ids = ((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toEqual([otherDm, forgedDm]);
  });
});
