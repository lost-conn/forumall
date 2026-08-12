/**
 * Chat store unit tests (P8): the de-dupe + optimistic-echo reconciliation, the
 * tombstone-in-place behavior, and the client-side reaction aggregation — the
 * core invariants the ChatView relies on.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Reaction } from "@forumall/shared";
import {
  addOptimistic,
  addReactionAgg,
  clearChat,
  cursorFor,
  messagesFor,
  olderCursorFor,
  prependHistory,
  reactionsFor,
  removeReactionAgg,
  setOlderCursor,
  setTyping,
  tombstoneMessage,
  typingFor,
  upsertMessage,
} from "../src/stores/chat.ts";

const CH = "ch_test";

/** Encode a cursor exactly as the server does: base64url of `{"seq":N}`. */
const cur = (seq: number): string =>
  btoa(JSON.stringify({ seq })).replace(/\+/g, "-").replace(/\//g, "_");

function reaction(over: Partial<Reaction>): Reaction {
  return {
    id: over.id ?? "rx_1",
    author: over.author ?? "alice@h",
    key: over.key ?? "+1",
    reference: over.reference ?? { type: "message", id: "m1" },
    createdAt: "2026-06-05T00:00:00Z",
    metadata: [],
    ...(over.unicode !== undefined ? { unicode: over.unicode } : {}),
  } as Reaction;
}

beforeEach(() => clearChat());

describe("de-dupe by id", () => {
  test("the same message id is upserted, not duplicated", () => {
    upsertMessage(CH, { id: "m1", author: "a@h", content: { text: "hi" }, cursor: "c1" });
    upsertMessage(CH, { id: "m1", author: "a@h", content: { text: "hi" }, cursor: "c1" });
    expect(messagesFor(CH)).toHaveLength(1);
  });
});

describe("optimistic echo reconciliation", () => {
  test("a matching message.created replaces the echo in place (no duplicate)", () => {
    addOptimistic(CH, {
      id: "optimistic:cmid_1",
      author: "me@h",
      content: { text: "hello" },
      clientMessageId: "cmid_1",
    });
    expect(messagesFor(CH)).toHaveLength(1);
    expect(messagesFor(CH)[0]?.pending).toBe(true);

    // Canonical message arrives with the same clientMessageId + the real id.
    upsertMessage(CH, {
      id: "m_real",
      author: "me@h",
      content: { text: "hello" },
      clientMessageId: "cmid_1",
      cursor: "c1",
    });

    const list = messagesFor(CH);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("m_real");
    expect(list[0]?.pending).toBe(false);
  });

  test("an unrelated message does not consume the echo", () => {
    addOptimistic(CH, {
      id: "optimistic:cmid_1",
      author: "me@h",
      content: { text: "a" },
      clientMessageId: "cmid_1",
    });
    upsertMessage(CH, { id: "m_other", author: "other@h", content: { text: "b" } });
    expect(messagesFor(CH)).toHaveLength(2);
  });
});

describe("tombstone in place", () => {
  test("deleting clears content + sets deletedAt but keeps the row/position", () => {
    upsertMessage(CH, { id: "m1", author: "a@h", content: { text: "one" } });
    upsertMessage(CH, { id: "m2", author: "a@h", content: { text: "two" } });
    tombstoneMessage(CH, "m1", "2026-06-05T00:00:00Z");
    const list = messagesFor(CH);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe("m1");
    expect(list[0]?.deletedAt).toBe("2026-06-05T00:00:00Z");
    expect(list[0]?.content.text).toBe("");
  });
});

describe("reaction aggregation", () => {
  test("counts and authors aggregate per key; removal decrements / clears", () => {
    addReactionAgg(CH, reaction({ author: "a@h", key: "+1", unicode: "👍" }));
    addReactionAgg(CH, reaction({ author: "b@h", key: "+1", unicode: "👍" }));
    addReactionAgg(CH, reaction({ author: "a@h", key: "heart", unicode: "❤️" }));

    let groups = reactionsFor(CH, "m1");
    const thumb = groups.find((g) => g.key === "+1");
    expect(thumb?.authors).toHaveLength(2);
    expect(thumb?.unicode).toBe("👍");

    removeReactionAgg(CH, "m1", "+1", "a@h");
    groups = reactionsFor(CH, "m1");
    expect(groups.find((g) => g.key === "+1")?.authors).toEqual(["b@h"]);

    removeReactionAgg(CH, "m1", "+1", "b@h");
    expect(reactionsFor(CH, "m1").find((g) => g.key === "+1")).toBeUndefined();
  });

  test("a repeated add by the same author is idempotent", () => {
    addReactionAgg(CH, reaction({ author: "a@h", key: "+1" }));
    addReactionAgg(CH, reaction({ author: "a@h", key: "+1" }));
    expect(reactionsFor(CH, "m1").find((g) => g.key === "+1")?.authors).toEqual(["a@h"]);
  });
});

describe("older-history paging", () => {
  test("the older cursor round-trips and is cleared with the store", () => {
    expect(olderCursorFor(CH)).toBeUndefined();
    setOlderCursor(CH, "cursor_older");
    expect(olderCursorFor(CH)).toBe("cursor_older");
    // Fully paged back → explicitly null (distinct from "not loaded yet").
    setOlderCursor(CH, null);
    expect(olderCursorFor(CH)).toBeNull();
    clearChat();
    expect(olderCursorFor(CH)).toBeUndefined();
  });

  test("a prepended page lands BEFORE the loaded window, in order", () => {
    upsertMessage(CH, { id: "m3", author: "a@h", content: { text: "three" }, cursor: "c3" });
    upsertMessage(CH, { id: "m4", author: "a@h", content: { text: "four" }, cursor: "c4" });

    // A backward page arrives newest-first; the controller reverses it.
    prependHistory(CH, [
      { id: "m1", author: "a@h", content: { text: "one" }, cursor: "c1" },
      { id: "m2", author: "a@h", content: { text: "two" }, cursor: "c2" },
    ]);

    expect(messagesFor(CH).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  test("an overlapping page merges in place instead of duplicating", () => {
    upsertMessage(CH, { id: "m2", author: "a@h", content: { text: "two" }, cursor: "c2" });
    prependHistory(CH, [
      { id: "m1", author: "a@h", content: { text: "one" }, cursor: "c1" },
      { id: "m2", author: "a@h", content: { text: "two (edited)" }, cursor: "c2" },
    ]);
    const list = messagesFor(CH);
    expect(list.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(list[1]?.content.text).toBe("two (edited)");
  });

  test("prepending older history never advances the resume cursor", () => {
    upsertMessage(CH, { id: "m9", author: "a@h", content: { text: "newest" }, cursor: cur(9) });
    const before = cursorFor(CH);
    expect(before).toBe(cur(9));
    prependHistory(CH, [{ id: "m1", author: "a@h", content: { text: "old" }, cursor: cur(1) }]);
    expect(cursorFor(CH)).toBe(before as string);
  });

  test("an optimistic echo stays at the bottom across a prepend", () => {
    upsertMessage(CH, { id: "m5", author: "a@h", content: { text: "five" }, cursor: "c5" });
    addOptimistic(CH, {
      id: "optimistic:cmid_1",
      author: "me@h",
      content: { text: "sending" },
      clientMessageId: "cmid_1",
    });
    prependHistory(CH, [{ id: "m1", author: "a@h", content: { text: "one" }, cursor: "c1" }]);
    expect(messagesFor(CH).map((m) => m.id)).toEqual(["m1", "m5", "optimistic:cmid_1"]);
  });
});

/**
 * `chat.cursors[channelId]` IS the WS resume `since` (§7.1) — a wrong pick makes a
 * reconnect replay or DROP messages. It must therefore track the highest DECODED
 * `seq`, never the "largest" cursor string (base64 JSON is not order-preserving).
 */
describe("resume cursor advances by seq", () => {
  test("advances to the higher seq even when its cursor string sorts lower", () => {
    // seq 99 → "eyJzZXEiOjk5fQ==", seq 100 → "eyJzZXEiOjEwMH0=" — the same
    // length, and the *older* one is lexically LARGER. The old comparator
    // therefore refused to advance here.
    upsertMessage(CH, { id: "m99", author: "a@h", content: { text: "99" }, cursor: cur(99) });
    upsertMessage(CH, { id: "m100", author: "a@h", content: { text: "100" }, cursor: cur(100) });
    expect(cursorFor(CH)).toBe(cur(100));
  });

  test("an out-of-order (older) arrival never rewinds the cursor", () => {
    upsertMessage(CH, { id: "m1000", author: "a@h", content: { text: "x" }, cursor: cur(1000) });
    upsertMessage(CH, { id: "m999", author: "a@h", content: { text: "y" }, cursor: cur(999) });
    expect(cursorFor(CH)).toBe(cur(1000));
  });

  test("an undecodable or absent cursor never advances it", () => {
    upsertMessage(CH, { id: "m5", author: "a@h", content: { text: "five" }, cursor: cur(5) });
    // A forged/garbage cursor…
    upsertMessage(CH, {
      id: "mx",
      author: "a@h",
      content: { text: "junk" },
      cursor: "!!garbage!!",
    });
    expect(cursorFor(CH)).toBe(cur(5));
    // …and a local optimistic echo, which has no server cursor at all.
    addOptimistic(CH, {
      id: "optimistic:cmid_1",
      author: "me@h",
      content: { text: "sending" },
      clientMessageId: "cmid_1",
    });
    upsertMessage(CH, {
      id: "m_real",
      author: "me@h",
      content: { text: "sending" },
      clientMessageId: "cmid_1",
    });
    expect(cursorFor(CH)).toBe(cur(5));
  });

  test("a reconciled echo carrying a cursor DOES advance it", () => {
    upsertMessage(CH, { id: "m9", author: "a@h", content: { text: "nine" }, cursor: cur(9) });
    addOptimistic(CH, {
      id: "optimistic:cmid_1",
      author: "me@h",
      content: { text: "mine" },
      clientMessageId: "cmid_1",
    });
    upsertMessage(CH, {
      id: "m10",
      author: "me@h",
      content: { text: "mine" },
      clientMessageId: "cmid_1",
      cursor: cur(10),
    });
    expect(cursorFor(CH)).toBe(cur(10));
  });
});

describe("typing", () => {
  test("start adds, stop removes", () => {
    setTyping(CH, "a@h", true);
    expect(typingFor(CH)).toEqual(["a@h"]);
    setTyping(CH, "a@h", true); // idempotent
    expect(typingFor(CH)).toEqual(["a@h"]);
    setTyping(CH, "a@h", false);
    expect(typingFor(CH)).toEqual([]);
  });
});
