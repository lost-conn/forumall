/**
 * Read positions (`lib/read-position.ts`, §7.7): how the newest history page
 * settles a scope's timeline head (the message a view marks read), and where
 * the "New messages" divider goes in the loaded list. No cursor is decoded.
 */
import { describe, expect, test } from "bun:test";
import {
  type TimelineEntry,
  dividerBeforeId,
  headAfterNewestPage,
} from "../src/lib/read-position.ts";

const ME = "me@a.test";
const m = (id: string, author = "bob@a.test", extra: Partial<TimelineEntry> = {}) => ({
  id,
  author,
  ...extra,
});

describe("headAfterNewestPage", () => {
  test("with nothing recorded yet, the page's newest message is the head", () => {
    expect(headAfterNewestPage(undefined, ["3", "2", "1"])).toBe("3");
  });

  test("a recorded head the page holds yields to the page's newest", () => {
    expect(headAfterNewestPage("2", ["3", "2", "1"])).toBe("3");
    expect(headAfterNewestPage("3", ["3", "2", "1"])).toBe("3");
  });

  test("a recorded head the page does not hold was committed after it, and stays", () => {
    expect(headAfterNewestPage("4", ["3", "2", "1"])).toBe("4");
  });

  test("an empty page leaves the head as it is", () => {
    expect(headAfterNewestPage("4", [])).toBe("4");
    expect(headAfterNewestPage(undefined, [])).toBeUndefined();
  });
});

describe("dividerBeforeId", () => {
  test("loaded marker: above the first later message by someone else", () => {
    const list = [m("1"), m("2"), m("3", ME), m("4"), m("5")];
    expect(dividerBeforeId(list, { lastReadMessageId: "2", unreadCount: 2 }, ME)).toBe("4");
  });

  test("loaded marker followed only by own messages: no divider", () => {
    const list = [m("1"), m("2"), m("3", ME)];
    expect(dividerBeforeId(list, { lastReadMessageId: "2", unreadCount: 0 }, ME)).toBeNull();
  });

  test("marker not loaded: unreadCount counts back from the newest", () => {
    const list = [m("5"), m("6"), m("7", ME), m("8")];
    expect(dividerBeforeId(list, { lastReadMessageId: "1", unreadCount: 2 }, ME)).toBe("6");
  });

  test("nothing read yet: unreadCount places it; more unread than loaded is the oldest loaded", () => {
    const list = [m("1"), m("2", ME), m("3")];
    expect(dividerBeforeId(list, { unreadCount: 1 }, ME)).toBe("3");
    expect(dividerBeforeId(list, { unreadCount: 40 }, ME)).toBe("1");
  });

  test("no unread and no loaded marker: no divider", () => {
    expect(dividerBeforeId([m("1")], { unreadCount: 0 }, ME)).toBeNull();
    expect(dividerBeforeId([m("1")], { lastReadMessageId: "x", unreadCount: 0 }, ME)).toBeNull();
  });

  test("unconfirmed echoes are never the divider and never counted", () => {
    const list = [m("1"), m("2"), m("opt_a", "bob@a.test", { pending: true })];
    expect(dividerBeforeId(list, { unreadCount: 1 }, ME)).toBe("2");
  });
});
