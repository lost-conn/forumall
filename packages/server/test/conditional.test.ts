/**
 * `If-None-Match` evaluation (RFC 9110 §13.1.2), shared by discovery (§3.1)
 * and attachment serving (§5.8).
 */
import { describe, expect, test } from "bun:test";

import { ifNoneMatchMatches } from "../src/http/conditional.ts";

describe("ifNoneMatchMatches", () => {
  test("strong and weak tags match by weak comparison", () => {
    expect(ifNoneMatchMatches('"abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchMatches('W/"abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(ifNoneMatchMatches('"abd"', '"abc"')).toBe(false);
  });

  test("lists, empty elements and commas inside a tag", () => {
    expect(ifNoneMatchMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchMatches(' "x" ,, W/"abc" ,', '"abc"')).toBe(true);
    expect(ifNoneMatchMatches('"a,b"', '"a,b"')).toBe(true);
    expect(ifNoneMatchMatches('"a,b"', '"a"')).toBe(false);
  });

  test("`*` matches; absent, empty or malformed never does", () => {
    expect(ifNoneMatchMatches("*", '"abc"')).toBe(true);
    expect(ifNoneMatchMatches(undefined, '"abc"')).toBe(false);
    expect(ifNoneMatchMatches("", '"abc"')).toBe(false);
    expect(ifNoneMatchMatches("abc", '"abc"')).toBe(false);
    expect(ifNoneMatchMatches('"abc" junk', '"abc"')).toBe(false);
    expect(ifNoneMatchMatches('"abc', '"abc"')).toBe(false);
  });
});
