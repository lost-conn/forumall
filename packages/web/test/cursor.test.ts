/**
 * Opaque-cursor codec + ordering tests (`lib/cursor.ts`).
 *
 * The regression these pin: cursors were previously ordered by comparing the
 * ENCODED base64 strings "length, then lexically". A cursor is
 * `base64url(JSON.stringify({ seq }))`, so that comparison is not
 * order-preserving — it flips at every decimal rollover of `seq` (9→10,
 * 99→100, 999→1000, and again at each `{"seq":N}` length change). Every case
 * below where the string order disagrees with the numeric order is a bug the
 * old comparator actually produced, on the WS resume `since` cursor.
 */
import { describe, expect, test } from "bun:test";
import {
  compareByCursorThenId,
  compareCursors,
  cursorAdvances,
  seqFromCursor,
} from "../src/lib/cursor.ts";

/** Encode a cursor exactly as the server does: base64url of `{"seq":N}`. */
function cur(seq: number): string {
  return btoa(JSON.stringify({ seq })).replace(/\+/g, "-").replace(/\//g, "_");
}

/** The OLD (broken) comparator, kept here to prove the cases actually differed. */
function oldStringLess(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

describe("seqFromCursor", () => {
  test("round-trips the server encoding", () => {
    expect(seqFromCursor(cur(1))).toBe(1);
    expect(seqFromCursor(cur(1000))).toBe(1000);
    expect(seqFromCursor(cur(0))).toBe(0);
  });

  test("absent / garbage / non-JSON / seq-less payloads decode to null", () => {
    expect(seqFromCursor(undefined)).toBeNull();
    expect(seqFromCursor(null)).toBeNull();
    expect(seqFromCursor("")).toBeNull();
    // Not base64 of anything JSON-shaped.
    expect(seqFromCursor("!!!not-a-cursor!!!")).toBeNull();
    // Valid base64, but the payload isn't JSON.
    expect(seqFromCursor(btoa("hello"))).toBeNull();
    // Valid JSON, but carries no `seq`.
    expect(seqFromCursor(btoa(JSON.stringify({ joinedAt: "x", user: "a@h" })))).toBeNull();
    // Valid JSON with a NON-numeric `seq` (a forged cursor).
    expect(seqFromCursor(btoa(JSON.stringify({ seq: "12" })))).toBeNull();
  });
});

describe("compareCursors orders by decoded seq, not by string", () => {
  // The decimal rollovers. `oldWasWrong` records whether the string comparison
  // actually inverted THIS pair: 9→10 changes the base64 length so it happened
  // to land right, while 99→100, 999→1000 (and 63→64, a same-length pair where
  // the encoded digit's base64 alphabet position flips) all came out backwards.
  for (const [lo, hi, oldWasWrong] of [
    [9, 10, false],
    [99, 100, true],
    [999, 1000, true],
    [63, 64, true],
  ] as const) {
    test(`seq ${lo} sorts before seq ${hi}`, () => {
      expect(compareCursors(cur(lo), cur(hi))).toBeLessThan(0);
      expect(compareCursors(cur(hi), cur(lo))).toBeGreaterThan(0);
      expect(compareCursors(cur(lo), cur(lo))).toBe(0);
      // Pin what the old string comparator answered, so the regression is
      // documented rather than merely fixed.
      expect(oldStringLess(cur(lo), cur(hi))).toBe(!oldWasWrong);
    });
  }

  test("cursorless sorts AFTER any decodable cursor; two cursorless tie", () => {
    expect(compareCursors(undefined, cur(1))).toBeGreaterThan(0);
    expect(compareCursors(cur(1), undefined)).toBeLessThan(0);
    expect(compareCursors("garbage", cur(1))).toBeGreaterThan(0);
    expect(compareCursors(undefined, undefined)).toBe(0);
    expect(compareCursors("garbage", "other-garbage")).toBe(0);
  });
});

describe("compareByCursorThenId", () => {
  test("cursored rows order by seq; cursorless rows follow, ordered by id", () => {
    const rows = [
      { id: "z", cursor: undefined },
      { id: "a", cursor: undefined },
      { id: "m", cursor: cur(100) },
      { id: "n", cursor: cur(9) },
    ];
    expect([...rows].sort(compareByCursorThenId).map((r) => r.id)).toEqual(["n", "m", "a", "z"]);
  });

  test("is a strict total order: repeated sorts are idempotent", () => {
    const rows = [
      { id: "c", cursor: cur(2) },
      { id: "a", cursor: undefined },
      { id: "b", cursor: cur(11) },
      { id: "d", cursor: "garbage" },
    ];
    const once = [...rows].sort(compareByCursorThenId).map((r) => r.id);
    const twice = [...rows]
      .sort(compareByCursorThenId)
      .sort(compareByCursorThenId)
      .map((r) => r.id);
    expect(twice).toEqual(once);
    // Antisymmetry over every pair: cmp(a,b) and cmp(b,a) must cancel.
    for (const a of rows) {
      for (const b of rows) {
        const ab = Math.sign(compareByCursorThenId(a, b));
        const ba = Math.sign(compareByCursorThenId(b, a));
        expect(ab + ba).toBe(0);
      }
    }
  });
});

describe("cursorAdvances (the WS resume `since`)", () => {
  test("advances only to a strictly higher seq", () => {
    expect(cursorAdvances(cur(9), cur(10))).toBe(true);
    expect(cursorAdvances(cur(10), cur(9))).toBe(false);
    expect(cursorAdvances(cur(10), cur(10))).toBe(false);
    expect(cursorAdvances(undefined, cur(1))).toBe(true);
  });

  test("an absent/undecodable candidate NEVER advances the stored cursor", () => {
    expect(cursorAdvances(cur(5), undefined)).toBe(false);
    expect(cursorAdvances(cur(5), "garbage")).toBe(false);
    expect(cursorAdvances(undefined, undefined)).toBe(false);
    expect(cursorAdvances(undefined, "garbage")).toBe(false);
  });

  test("a decodable candidate replaces an undecodable stored cursor", () => {
    // Garbage is useless as a resume point, so anything real beats it.
    expect(cursorAdvances("garbage", cur(1))).toBe(true);
  });
});
