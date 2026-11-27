/**
 * Read positions from loaded ids and order (`lib/read-position.ts`, §7.7): which
 * message a view marks read, and where the "New messages" divider goes. No
 * cursor is decoded; the list order is the timeline.
 */
import { describe, expect, test } from "bun:test";
import {
  type TimelineEntry,
  dividerBeforeId,
  newestConfirmedId,
} from "../src/lib/read-position.ts";

const ME = "me@a.test";
const m = (id: string, author = "bob@a.test", extra: Partial<TimelineEntry> = {}) => ({
  id,
  author,
  ...extra,
});

describe("newestConfirmedId", () => {
  test("the last confirmed message by position", () => {
    expect(newestConfirmedId([m("1"), m("2"), m("3")])).toBe("3");
  });

  test("skips pending and failed optimistic echoes", () => {
    const list = [
      m("1"),
      m("2"),
      m("opt_a", ME, { pending: true }),
      m("opt_b", ME, { failed: true }),
    ];
    expect(newestConfirmedId(list)).toBe("2");
  });

  test("honours keep, and is undefined when nothing qualifies", () => {
    const list = [m("1"), m("2", ME)];
    expect(newestConfirmedId(list, (x) => x.author !== ME)).toBe("1");
    expect(newestConfirmedId([m("1", ME)], (x) => x.author !== ME)).toBeUndefined();
    expect(newestConfirmedId([])).toBeUndefined();
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
