/**
 * The §7.2 `limit` query param: default 50 (left to the pager), max 100,
 * fractions rounded down, and nothing about it is ever an error.
 */
import { describe, expect, test } from "bun:test";

import { parsePageLimit } from "../src/http/page-query.ts";

describe("parsePageLimit", () => {
  test("a plain positive integer passes through", () => {
    expect(parsePageLimit("1")).toBe(1);
    expect(parsePageLimit("50")).toBe(50);
    expect(parsePageLimit("100")).toBe(100);
  });

  test("a fractional value is rounded down", () => {
    expect(parsePageLimit("2.9")).toBe(2);
  });

  test("a larger value is clamped to 100", () => {
    expect(parsePageLimit("150")).toBe(100);
    expect(parsePageLimit("100.5")).toBe(100);
  });

  test("an exponent form is read as the number it is", () => {
    expect(parsePageLimit("1e3")).toBe(100);
    expect(parsePageLimit("2e1")).toBe(20);
  });

  test("trailing garbage makes the value non-numeric, so the default applies", () => {
    expect(parsePageLimit("150abc")).toBeUndefined();
    expect(parsePageLimit("10px")).toBeUndefined();
  });

  test("missing, empty, non-numeric or non-positive values mean the default", () => {
    expect(parsePageLimit(undefined)).toBeUndefined();
    expect(parsePageLimit("")).toBeUndefined();
    expect(parsePageLimit("abc")).toBeUndefined();
    expect(parsePageLimit("0")).toBeUndefined();
    expect(parsePageLimit("-5")).toBeUndefined();
    expect(parsePageLimit("0.5")).toBeUndefined();
  });

  test("forms Number() accepts but that are not decimal numbers mean the default", () => {
    expect(parsePageLimit("0x10")).toBeUndefined();
    expect(parsePageLimit("Infinity")).toBeUndefined();
  });
});
