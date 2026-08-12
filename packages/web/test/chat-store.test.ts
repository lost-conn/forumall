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
    upsertMessage(CH, { id: "m9", author: "a@h", content: { text: "newest" }, cursor: "c9" });
    const before = cursorFor(CH);
    prependHistory(CH, [{ id: "m1", author: "a@h", content: { text: "old" }, cursor: "c1" }]);
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
