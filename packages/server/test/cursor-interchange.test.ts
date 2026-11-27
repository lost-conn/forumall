/**
 * §7.2 "Cursors" and §7.1 "Resuming after a disconnect": a channel's timeline
 * cursors share one space, and so do a DM conversation's on its provider.
 *
 *  - a timeline event's `cursor` is a valid `cursor` for the channel's history
 *    and its reply listing; a `nextCursor` / `prevCursor` from either listing
 *    is a valid `subscribe.since`;
 *  - likewise a `dm.message` cursor for `GET /api/dms/{dmId}/messages` and the
 *    conversation's reply listing, whose page cursors resume a `dmId`
 *    subscription.
 */
import { describe, expect, test } from "bun:test";
import { type WsEnvelope, deriveDmId, rfc3339Timestamp } from "@forumall/shared";

import {
  type Booted,
  type Signer,
  type WsClient,
  connectAuthenticated,
  makeGroupChannel,
  registerUserWithKey,
  signedReq,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-cursor-interchange-");

interface Page {
  items: { id: string }[];
  page: { nextCursor?: string; prevCursor?: string };
}

async function page(b: Booted, signer: Signer, path: string): Promise<Page> {
  const res = await signedReq(b, signer, "GET", path);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

const idsOf = (p: Page) => p.items.map((m) => m.id);

/** Subscribe `target` from `since` and collect the replayed events' message ids. */
async function replayFrom(
  conn: WsClient,
  target: string,
  since: string,
  event: string,
  id: string,
): Promise<string[]> {
  conn.send({
    id,
    type: "subscribe",
    ts: rfc3339Timestamp(),
    data: { channels: [target], since: { [target]: since } },
  });
  const ack = await conn.next((f) => f.type === "subscribed" && f.correlationId === id);
  expect((ack.data as { truncated?: string[] }).truncated).toBeUndefined();
  const replayed: string[] = [];
  const isReplay = (f: WsEnvelope) => f.type === event && f.correlationId === id;
  // The replay is sent right after the ack; it is over once none follows.
  for (;;) {
    const frame = await conn.next(isReplay, 200).catch(() => null);
    if (frame === null) return replayed;
    replayed.push((frame.data as { message: { id: string } }).message.id);
  }
}

describe("a channel's timeline cursors share one space (§7.1, §7.2)", () => {
  test("event cursors page history and replies; page cursors resume a subscription", async () => {
    const b = boot("cursor-channel");
    const alice = await registerUserWithKey(b, "alice");
    const ids = await makeGroupChannel(b, alice);
    const base = `/api/groups/${ids.groupId}/channels/${ids.channelId}/messages`;
    const poster = await connectAuthenticated(b, alice);

    // m1, m2, r1 (reply to m1), m3, r2 (reply to m1), posted over WS for
    // their event cursors.
    const posted: { id: string; cursor: string }[] = [];
    const post = async (text: string, replyTo?: string) => {
      const id = `c${posted.length}`;
      poster.send({
        id,
        type: "message.create",
        ts: rfc3339Timestamp(),
        data: {
          ...ids,
          content: { mime: "text/plain", text },
          ...(replyTo !== undefined ? { reference: { type: "reply", id: replyTo } } : {}),
        },
      });
      const evt = await poster.next((f) => f.type === "message.created" && f.correlationId === id);
      const data = evt.data as { cursor: string; message: { id: string } };
      posted.push({ id: data.message.id, cursor: data.cursor });
      return posted[posted.length - 1] as { id: string; cursor: string };
    };
    const m1 = await post("m1");
    const m2 = await post("m2");
    const r1 = await post("r1", m1.id);
    const m3 = await post("m3");
    const r2 = await post("r2", m1.id);

    // An event cursor as the history cursor, both directions.
    expect(idsOf(await page(b, alice, `${base}?direction=forward&cursor=${m2.cursor}`))).toEqual([
      r1.id,
      m3.id,
      r2.id,
    ]);
    expect(idsOf(await page(b, alice, `${base}?cursor=${m3.cursor}`))).toEqual([
      r1.id,
      m2.id,
      m1.id,
    ]);
    // An event cursor as the reply listing's cursor: a reply's, and a
    // non-reply's from the same timeline.
    const replies = `${base}/${m1.id}/replies`;
    expect(idsOf(await page(b, alice, `${replies}?direction=forward&cursor=${r1.cursor}`))).toEqual(
      [r2.id],
    );
    expect(idsOf(await page(b, alice, `${replies}?direction=forward&cursor=${m2.cursor}`))).toEqual(
      [r1.id, r2.id],
    );

    // History's page cursors as `since`.
    const first = await page(b, alice, `${base}?direction=forward&limit=2`);
    expect(idsOf(first)).toEqual([m1.id, m2.id]);
    const resumer = await connectAuthenticated(b, alice);
    const next = first.page.nextCursor as string;
    expect(await replayFrom(resumer, ids.channelId, next, "message.created", "s1")).toEqual([
      r1.id,
      m3.id,
      r2.id,
    ]);
    const prev = first.page.prevCursor as string;
    expect(await replayFrom(resumer, ids.channelId, prev, "message.created", "s2")).toEqual([
      m2.id,
      r1.id,
      m3.id,
      r2.id,
    ]);
    // The reply listing's page cursor as `since`.
    const firstReply = await page(b, alice, `${replies}?direction=forward&limit=1`);
    expect(idsOf(firstReply)).toEqual([r1.id]);
    const afterReply = firstReply.page.nextCursor as string;
    expect(await replayFrom(resumer, ids.channelId, afterReply, "message.created", "s3")).toEqual([
      m3.id,
      r2.id,
    ]);

    poster.close();
    resumer.close();
  });
});

describe("a DM conversation's cursors share one space on its provider (§7.2, §7.4)", () => {
  test("dm.message cursors page history and replies; page cursors resume a dmId subscription", async () => {
    const b = boot("cursor-dm");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const base = `/api/dms/${dmId}/messages`;

    const watcher = await connectAuthenticated(b, bob);
    await subscribe(watcher, dmId);
    // d1, d2, d3 (reply to d1), d4 (reply to d1): alice → bob's inbox.
    const sent: { id: string; cursor: string }[] = [];
    const send = async (text: string, replyTo?: string) => {
      const res = await signedReq(b, alice, "POST", `/api/federation/dms/${dmId}/messages`, {
        clientMessageId: `cmsg_${sent.length}`,
        content: { mime: "text/plain", text },
        ...(replyTo !== undefined ? { reference: { type: "reply", id: replyTo } } : {}),
      });
      expect(res.status).toBe(201);
      const evt = await watcher.next((f) => f.type === "dm.message");
      const data = evt.data as { cursor: string; message: { id: string } };
      sent.push({ id: data.message.id, cursor: data.cursor });
      return sent[sent.length - 1] as { id: string; cursor: string };
    };
    const d1 = await send("d1");
    const d2 = await send("d2");
    const d3 = await send("d3", d1.id);
    const d4 = await send("d4", d1.id);

    // A `dm.message` cursor as the history and reply-listing cursor.
    expect(idsOf(await page(b, bob, `${base}?direction=forward&cursor=${d1.cursor}`))).toEqual([
      d2.id,
      d3.id,
      d4.id,
    ]);
    const replies = `${base}/${d1.id}/replies`;
    expect(idsOf(await page(b, bob, `${replies}?direction=forward&cursor=${d2.cursor}`))).toEqual([
      d3.id,
      d4.id,
    ]);

    // The listings' page cursors as `since`.
    const first = await page(b, bob, `${base}?direction=forward&limit=1`);
    expect(idsOf(first)).toEqual([d1.id]);
    const resumer = await connectAuthenticated(b, bob);
    const next = first.page.nextCursor as string;
    expect(await replayFrom(resumer, dmId, next, "dm.message", "s1")).toEqual([
      d2.id,
      d3.id,
      d4.id,
    ]);
    const firstReply = await page(b, bob, `${replies}?direction=forward&limit=1`);
    expect(idsOf(firstReply)).toEqual([d3.id]);
    const afterReply = firstReply.page.nextCursor as string;
    expect(await replayFrom(resumer, dmId, afterReply, "dm.message", "s2")).toEqual([d4.id]);

    watcher.close();
    resumer.close();
  });
});
