/**
 * WebSocket resume tests (spec §7.1 Resuming after a disconnect): `since`
 * replay, truncation, and cursors on live timeline events.
 *
 * See `helpers/ws-harness.ts` for the real-socket harness.
 */
import { describe, expect, test } from "bun:test";
import { rfc3339Timestamp } from "@forumall/shared";
import { at } from "./helpers/at.ts";

import {
  FAST_TIMINGS,
  type WsClient,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  signedReq,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-ws-resume-");

describe("WS resume (§7.1 Resuming after a disconnect)", () => {
  /** Post a message over WS and return its canonical id + cursor. */
  async function postMessage(
    client: WsClient,
    groupId: string,
    channelId: string,
    text: string,
    id: string,
  ): Promise<{ messageId: string; cursor: string }> {
    client.send({
      id,
      type: "message.create",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, content: { mime: "text/plain", text } },
    });
    const evt = await client.next((f) => f.type === "message.created" && f.correlationId === id);
    const data = evt.data as { cursor: string; message: { id: string } };
    return { messageId: data.message.id, cursor: data.cursor };
  }

  test("subscribe with `since` replays post-cursor messages (ascending) before live events", async () => {
    const b = boot("resume-basic");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    // Poster connection (also subscribes so its creates persist + fan out).
    const poster = await connectAuthenticated(b, alice);
    poster.send({
      id: "p_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    await poster.ofType("subscribed");

    // Post N=5 messages; remember the cursor of message k=2 (1-indexed).
    const N = 5;
    const cursors: string[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= N; i++) {
      const { messageId, cursor } = await postMessage(poster, groupId, channelId, `m${i}`, `p${i}`);
      cursors.push(cursor);
      ids.push(messageId);
    }
    const k = 2;
    const sinceCursor = cursors[k - 1] as string;

    // A fresh connection resumes from message k → expects replays for k+1..N.
    const resumer = await connectAuthenticated(b, alice);
    resumer.send({
      id: "r_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId], since: { [channelId]: sinceCursor } },
    });
    const ack = await resumer.ofType("subscribed");
    expect((ack.data as { channels: string[] }).channels).toEqual([channelId]);
    expect((ack.data as { truncated?: string[] }).truncated).toBeUndefined();

    // Replays arrive ascending for messages k+1..N, each a message.created with a cursor.
    for (let i = k + 1; i <= N; i++) {
      const evt = await resumer.ofType("message.created");
      const data = evt.data as {
        cursor: string;
        message: { id: string; content: { text: string } };
      };
      expect(data.message.id).toBe(at(ids, i - 1));
      expect(data.message.content.text).toBe(`m${i}`);
      expect(typeof data.cursor).toBe("string");
    }

    // A NEW live message now flows AFTER the replay, in order, no gap.
    const live = await postMessage(poster, groupId, channelId, "m6", "p6");
    const liveEvt = await resumer.ofType("message.created");
    expect((liveEvt.data as { message: { id: string } }).message.id).toBe(live.messageId);

    poster.close();
    resumer.close();
  });

  test("an edited / deleted message after the cursor is replayed in its current state", async () => {
    const b = boot("resume-current-state");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const poster = await connectAuthenticated(b, alice);
    poster.send({
      id: "p_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    await poster.ofType("subscribed");

    // Anchor message (cursor we resume from), then two post-cursor messages.
    const anchor = await postMessage(poster, groupId, channelId, "anchor", "p0");
    const toEdit = await postMessage(poster, groupId, channelId, "original", "p1");
    const toDelete = await postMessage(poster, groupId, channelId, "doomed", "p2");

    // Edit one and delete the other (via REST, after the cursor).
    const editRes = await signedReq(
      b,
      alice,
      "PATCH",
      `/api/groups/${groupId}/channels/${channelId}/messages/${toEdit.messageId}`,
      { content: { mime: "text/plain", text: "edited!" } },
    );
    expect(editRes.status).toBe(200);
    const delRes = await signedReq(
      b,
      alice,
      "DELETE",
      `/api/groups/${groupId}/channels/${channelId}/messages/${toDelete.messageId}`,
    );
    expect(delRes.status).toBe(204);

    // Resume from the anchor: replays reflect the CURRENT state (edited / tombstone).
    const resumer = await connectAuthenticated(b, alice);
    resumer.send({
      id: "r_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId], since: { [channelId]: anchor.cursor } },
    });
    await resumer.ofType("subscribed");

    const e1 = await resumer.ofType("message.created");
    const m1 = (e1.data as { message: { id: string; content: { text: string } } }).message;
    expect(m1.id).toBe(toEdit.messageId);
    expect(m1.content.text).toBe("edited!");

    const e2 = await resumer.ofType("message.created");
    const m2 = (
      e2.data as {
        message: { id: string; deletedAt?: string; content: { text: string } };
      }
    ).message;
    expect(m2.id).toBe(toDelete.messageId);
    expect(typeof m2.deletedAt).toBe("string"); // tombstone
    expect(m2.content.text).toBe(""); // content cleared

    poster.close();
    resumer.close();
  });

  test("truncation: gap exceeding maxResumeReplay → channel listed in `truncated`, no replay", async () => {
    // Cap replay at 2 so a 3-message gap truncates.
    const b = boot("resume-truncate", FAST_TIMINGS, { MAX_RESUME_REPLAY: "2" });
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const poster = await connectAuthenticated(b, alice);
    poster.send({
      id: "p_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    await poster.ofType("subscribed");

    // Anchor, then 3 post-cursor messages (> cap of 2).
    const anchor = await postMessage(poster, groupId, channelId, "anchor", "p0");
    for (let i = 1; i <= 3; i++) {
      await postMessage(poster, groupId, channelId, `m${i}`, `p${i}`);
    }

    const resumer = await connectAuthenticated(b, alice);
    resumer.send({
      id: "r_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId], since: { [channelId]: anchor.cursor } },
    });
    const ack = await resumer.ofType("subscribed");
    expect((ack.data as { channels: string[] }).channels).toEqual([channelId]);
    expect((ack.data as { truncated?: string[] }).truncated).toEqual([channelId]);

    // No replay events for the truncated channel: a live post is the first
    // message.created the resumer sees (proves nothing was replayed before it).
    const live = await postMessage(poster, groupId, channelId, "live", "pL");
    const liveEvt = await resumer.ofType("message.created");
    expect((liveEvt.data as { message: { id: string } }).message.id).toBe(live.messageId);

    poster.close();
    resumer.close();
  });

  test("message.updated and message.deleted live events carry a cursor", async () => {
    const b = boot("resume-event-cursor");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const a = await connectAuthenticated(b, alice);
    a.send({
      id: "a_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    await a.ofType("subscribed");

    const toEdit = await postMessage(a, groupId, channelId, "v1", "pe");
    const toDelete = await postMessage(a, groupId, channelId, "del", "pd");

    a.send({
      id: "cli_edit",
      type: "message.update",
      ts: rfc3339Timestamp(),
      data: {
        groupId,
        channelId,
        messageId: toEdit.messageId,
        content: { mime: "text/plain", text: "v2" },
      },
    });
    const upd = await a.ofType("message.updated");
    expect(typeof (upd.data as { cursor?: string }).cursor).toBe("string");
    expect((upd.data as { cursor: string }).cursor).toBe(toEdit.cursor);

    a.send({
      id: "cli_del",
      type: "message.delete",
      ts: rfc3339Timestamp(),
      data: { groupId, channelId, messageId: toDelete.messageId },
    });
    const del = await a.ofType("message.deleted");
    expect(typeof (del.data as { cursor?: string }).cursor).toBe("string");
    expect((del.data as { cursor: string }).cursor).toBe(toDelete.cursor);

    a.close();
  });

  test("subscribe WITHOUT `since` → no replay (existing behavior intact)", async () => {
    const b = boot("resume-none");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);

    const poster = await connectAuthenticated(b, alice);
    poster.send({
      id: "p_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    await poster.ofType("subscribed");
    for (let i = 1; i <= 3; i++) {
      await postMessage(poster, groupId, channelId, `m${i}`, `p${i}`);
    }

    // No `since` → no historical replay; ack has no `truncated`.
    const resumer = await connectAuthenticated(b, alice);
    resumer.send({
      id: "r_sub",
      type: "subscribe",
      ts: rfc3339Timestamp(),
      data: { channels: [channelId] },
    });
    const ack = await resumer.ofType("subscribed");
    expect((ack.data as { truncated?: string[] }).truncated).toBeUndefined();

    // First message.created the resumer sees is a NEW live post, not a replay.
    const live = await postMessage(poster, groupId, channelId, "live", "pL");
    const liveEvt = await resumer.ofType("message.created");
    expect((liveEvt.data as { message: { id: string } }).message.id).toBe(live.messageId);

    poster.close();
    resumer.close();
  });
});
