/**
 * Notify-FX pure-logic tests: the per-scope policy seam defaults, the sound
 * eligibility decision (event + active-thread + focus + self), the presence
 * suppression, the dedupe (same source id twice → one sound), and the
 * total-unread computation. The audio/canvas/DOM side-effects in `notify-fx.ts`
 * aren't tested here (no browser); the gating logic is fully covered via the
 * pure `notify-fx-core.ts` seam.
 */
import { describe, expect, test } from "bun:test";
import {
  Deduper,
  type EligibilityContext,
  type SoundCandidate,
  badgeLabel,
  computeTotalUnread,
  notifyContentFor,
  notifyEligible,
  notifyPolicyFor,
  previewText,
  soundEligible,
  suppressedByPresence,
} from "../src/stores/notify-fx-core.ts";

const ME = "me@h";
const OTHER = "alice@h";

describe("notifyPolicyFor (the per-channel settings seam)", () => {
  test("the OPEN scope defaults to 'all'", () => {
    expect(notifyPolicyFor("chn_1", "chn_1")).toBe("all");
  });
  test("a non-open scope defaults to 'mentions'", () => {
    expect(notifyPolicyFor("chn_1", "chn_2")).toBe("mentions");
    expect(notifyPolicyFor("chn_1", null)).toBe("mentions");
  });
});

function ctx(over: Partial<EligibilityContext> = {}): EligibilityContext {
  return { me: ME, activeScopeId: null, ...over };
}

describe("soundEligible — dm.message", () => {
  const base: SoundCandidate = {
    source: "dm.message",
    scopeId: "dm_x",
    sourceMessageId: "m1",
    author: OTHER,
    mine: false,
  };
  test("an incoming DM (!mine) is eligible", () => {
    expect(soundEligible(base, ctx())).toBe(true);
  });
  test("my own DM (mine) is NOT eligible", () => {
    expect(soundEligible({ ...base, mine: true, author: ME }, ctx())).toBe(false);
  });
});

describe("soundEligible — notification.created", () => {
  const base: SoundCandidate = {
    source: "notification.created",
    scopeId: "chn_1",
    sourceMessageId: "m1",
    author: OTHER,
  };
  test("a received mention/reply is eligible", () => {
    expect(soundEligible(base, ctx())).toBe(true);
  });
  test("self-authored (defensive) is not eligible", () => {
    expect(soundEligible({ ...base, author: ME }, ctx())).toBe(false);
  });
});

describe("soundEligible — channel message.created", () => {
  const base: SoundCandidate = {
    source: "message.created",
    scopeId: "chn_1",
    sourceMessageId: "m1",
    author: OTHER,
  };
  test("a message in the OPEN channel by someone else is eligible (policy 'all')", () => {
    expect(soundEligible(base, ctx({ activeScopeId: "chn_1" }))).toBe(true);
  });
  test("a message in a BACKGROUND channel is NOT eligible (policy 'mentions')", () => {
    expect(soundEligible(base, ctx({ activeScopeId: "chn_2" }))).toBe(false);
    expect(soundEligible(base, ctx({ activeScopeId: null }))).toBe(false);
  });
  test("my own message in the open channel is never eligible", () => {
    expect(soundEligible({ ...base, author: ME }, ctx({ activeScopeId: "chn_1" }))).toBe(false);
  });
});

describe("notifyEligible — the desktop-notification set (mirrors Web Push)", () => {
  test("an incoming DM is eligible; my own DM is not", () => {
    const dm: SoundCandidate = { source: "dm.message", scopeId: "dm_x", sourceMessageId: "m1" };
    expect(notifyEligible({ ...dm, author: OTHER, mine: false }, ctx())).toBe(true);
    expect(notifyEligible({ ...dm, author: ME, mine: true }, ctx())).toBe(false);
  });
  test("a received mention/reply is eligible; self-authored is not", () => {
    const n: SoundCandidate = {
      source: "notification.created",
      scopeId: "chn_1",
      sourceMessageId: "m1",
    };
    expect(notifyEligible({ ...n, author: OTHER }, ctx())).toBe(true);
    expect(notifyEligible({ ...n, author: ME }, ctx())).toBe(false);
  });
  test("a plain channel message NEVER desktop-notifies (only chimes)", () => {
    const msg: SoundCandidate = {
      source: "message.created",
      scopeId: "chn_1",
      sourceMessageId: "m1",
      author: OTHER,
    };
    // Even in the OPEN channel where it would chime.
    expect(notifyEligible(msg, ctx({ activeScopeId: "chn_1" }))).toBe(false);
  });
});

describe("notifyContentFor — mirrors the server push payloads (coalesce by tag)", () => {
  test("a DM carries the author + body preview + dm: tag + /dms route", () => {
    const out = notifyContentFor({
      source: "dm.message",
      scopeId: "dm_x",
      sourceMessageId: "m1",
      author: "alice@h",
      text: "  hello   there  ",
    });
    expect(out).toEqual({
      title: "alice",
      body: "hello there",
      tag: "dm:dm_x",
      targetUrl: "/dms/dm_x",
    });
  });
  test("a mention has a verb title, empty body, chan: tag + /groups route", () => {
    const out = notifyContentFor({
      source: "notification.created",
      scopeId: "chn_1",
      sourceMessageId: "m1",
      author: "bob@h",
      groupId: "grp_9",
      notifType: "mention",
    });
    expect(out).toEqual({
      title: "New mention from bob",
      body: "",
      tag: "chan:grp_9",
      targetUrl: "/groups/grp_9",
    });
  });
  test("a reply uses the 'reply' verb", () => {
    const out = notifyContentFor({
      source: "notification.created",
      scopeId: "chn_1",
      sourceMessageId: "m1",
      author: "bob@h",
      groupId: "grp_9",
      notifType: "reply",
    });
    expect(out.title).toBe("New reply from bob");
  });
});

describe("previewText", () => {
  test("collapses whitespace and trims", () => {
    expect(previewText("  a\n\n b   c ")).toBe("a b c");
  });
  test("clamps to max with an ellipsis", () => {
    expect(previewText("abcdef", 4)).toBe("abc…");
  });
});

describe("suppressedByPresence", () => {
  test("focused + watching the active thread → suppressed", () => {
    expect(suppressedByPresence("chn_1", { appFocused: true, activeScopeId: "chn_1" })).toBe(true);
  });
  test("tabbed-away (not focused) → NOT suppressed even on the active thread", () => {
    expect(suppressedByPresence("chn_1", { appFocused: false, activeScopeId: "chn_1" })).toBe(
      false,
    );
  });
  test("focused but on a different thread → NOT suppressed", () => {
    expect(suppressedByPresence("chn_1", { appFocused: true, activeScopeId: "chn_2" })).toBe(false);
    expect(suppressedByPresence("chn_1", { appFocused: true, activeScopeId: null })).toBe(false);
  });
});

describe("Deduper — channel @mention double-fire collapses to one sound", () => {
  test("the same source id twice within the window sounds once", () => {
    const d = new Deduper(1500, 50);
    expect(d.shouldSound("m1", 1000)).toBe(true); // message.created
    expect(d.shouldSound("m1", 1050)).toBe(false); // notification.created (same msg)
  });
  test("the same id AFTER the window sounds again", () => {
    const d = new Deduper(1500, 50);
    expect(d.shouldSound("m1", 1000)).toBe(true);
    expect(d.shouldSound("m1", 3000)).toBe(true); // > 1.5s later → fresh
  });
  test("distinct ids each sound", () => {
    const d = new Deduper();
    expect(d.shouldSound("m1", 1000)).toBe(true);
    expect(d.shouldSound("m2", 1000)).toBe(true);
  });
  test("the set is capped (does not grow unbounded)", () => {
    const d = new Deduper(10_000, 3);
    for (let i = 0; i < 10; i++) expect(d.shouldSound(`m${i}`, 1000 + i)).toBe(true);
    // The earliest evicted ids may sound again; the most-recent stay deduped.
    expect(d.shouldSound("m9", 1009)).toBe(false);
  });
});

describe("computeTotalUnread + badgeLabel", () => {
  test("sums read-marker total + unseen mentions + unseen replies", () => {
    expect(computeTotalUnread(3, 2, 1)).toBe(6);
    expect(computeTotalUnread(0, 0, 0)).toBe(0);
  });
  test("clamps negative inputs", () => {
    expect(computeTotalUnread(-5, 2, -1)).toBe(2);
  });
  test("badgeLabel caps at 99+", () => {
    expect(badgeLabel(5)).toBe("5");
    expect(badgeLabel(99)).toBe("99");
    expect(badgeLabel(100)).toBe("99+");
    expect(badgeLabel(1000)).toBe("99+");
  });
});
