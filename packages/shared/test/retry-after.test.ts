/** Strict `Retry-After` parsing (RFC 9110 §10.2.3; OFSCP §4.5 warm-up retries). */
import { describe, expect, test } from "bun:test";

import { MIN_RETRY_AFTER_MS, parseRetryAfterMs } from "../src/retry-after.ts";

const NOW = Date.parse("2026-06-01T12:00:00Z");

describe("parseRetryAfterMs", () => {
  test("positive integer delta-seconds", () => {
    expect(parseRetryAfterMs("1", NOW)).toBe(1_000);
    expect(parseRetryAfterMs("120", NOW)).toBe(120_000);
    expect(parseRetryAfterMs(" 300 ", NOW)).toBe(300_000);
  });

  test("future IMF-fixdate", () => {
    expect(parseRetryAfterMs("Mon, 01 Jun 2026 12:00:30 GMT", NOW)).toBe(30_000);
  });

  test("a future date under a second away is floored to the minimum wait", () => {
    // 500ms in the future relative to `now`.
    expect(parseRetryAfterMs("Mon, 01 Jun 2026 12:00:00 GMT", NOW - 500)).toBe(MIN_RETRY_AFTER_MS);
  });

  test("zero, negative, fractional, garbage, past and non-IMF dates are unusable", () => {
    for (const bad of [
      "0",
      "00",
      "-5",
      "1.5",
      "+5",
      "1e3",
      "soon",
      "",
      "Mon, 01 Jun 2026 11:59:59 GMT", // past
      "Mon, 01 Jun 2026 12:00:00 GMT", // now
      "Monday, 01-Jun-26 12:00:30 GMT", // obsolete RFC 850 form
      "2026-06-01T12:00:30Z", // ISO 8601 is not a Retry-After form
    ]) {
      expect({ bad, ms: parseRetryAfterMs(bad, NOW) }).toEqual({ bad, ms: null });
    }
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
  });
});
