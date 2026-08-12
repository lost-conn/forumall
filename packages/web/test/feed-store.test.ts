/**
 * Home-feed store tests (§7.6): the merged timeline is DERIVED from the shared
 * chat store, so its ordering is the only thing this store really owns.
 *
 * Server timestamps are SECOND-precision (`rfc3339Timestamp` drops millis), so
 * items posted within one second tie on `createdAt` and the cursor decides. The
 * cursor is `base64url({"seq":N})` — comparing the ENCODED strings inverts at
 * decimal rollovers (99→100, 999→1000), which is what these pin.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { clearChat, upsertMessage } from "../src/stores/chat.ts";
import { clearFeed, mergedTimeline, setFollows } from "../src/stores/feed.ts";

/** Encode a cursor exactly as the server does: base64url of `{"seq":N}`. */
const cur = (seq: number): string =>
  btoa(JSON.stringify({ seq })).replace(/\+/g, "-").replace(/\//g, "_");

const CH = "chn_feed";
const T = "2026-06-05T00:00:00Z";

beforeEach(() => {
  clearChat();
  clearFeed();
  setFollows([{ channelId: CH, ref: CH, host: "h", groupId: "grp_1" }]);
});

describe("mergedTimeline ordering", () => {
  test("same-second items order by seq, newest first", () => {
    // Ids ascend as the seqs DESCEND, so an id tie-break would invert this.
    upsertMessage(CH, { id: "msg_a", author: "a@h", content: {}, createdAt: T, cursor: cur(9) });
    upsertMessage(CH, { id: "msg_b", author: "a@h", content: {}, createdAt: T, cursor: cur(100) });
    upsertMessage(CH, { id: "msg_c", author: "a@h", content: {}, createdAt: T, cursor: cur(1000) });
    expect(mergedTimeline().map((m) => m.id)).toEqual(["msg_c", "msg_b", "msg_a"]);
  });

  test("createdAt still dominates the cursor tie-break", () => {
    upsertMessage(CH, {
      id: "msg_old",
      author: "a@h",
      content: {},
      createdAt: T,
      cursor: cur(999),
    });
    upsertMessage(CH, {
      id: "msg_new",
      author: "a@h",
      content: {},
      createdAt: "2026-06-05T00:00:01Z",
      cursor: cur(1),
    });
    expect(mergedTimeline().map((m) => m.id)).toEqual(["msg_new", "msg_old"]);
  });

  test("optimistic (pending) rows are excluded from the feed", () => {
    upsertMessage(CH, { id: "msg_a", author: "a@h", content: {}, createdAt: T, cursor: cur(1) });
    upsertMessage(CH, {
      id: "optimistic:c1",
      author: "me@h",
      content: {},
      createdAt: T,
      clientMessageId: "c1",
      pending: true,
    });
    expect(mergedTimeline().map((m) => m.id)).toEqual(["msg_a"]);
  });

  test("a pruned follow drops out of the timeline", () => {
    upsertMessage(CH, { id: "msg_a", author: "a@h", content: {}, createdAt: T, cursor: cur(1) });
    setFollows([{ channelId: CH, ref: CH, host: "h", pruned: true }]);
    expect(mergedTimeline()).toHaveLength(0);
  });
});
