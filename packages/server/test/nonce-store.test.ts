/**
 * In-memory replay/nonce store tests (spec §4.5 step 4).
 *
 * Uses an injected clock so expiry is deterministic without real waits.
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_NONCE_RETENTION_MS, InMemoryNonceStore } from "../src/provider/nonce-store.ts";

describe("InMemoryNonceStore", () => {
  test("remember then has → true; unseen pair → false", () => {
    const s = new InMemoryNonceStore();
    expect(s.has("k1", "n1")).toBe(false);
    s.remember("k1", "n1", DEFAULT_NONCE_RETENTION_MS);
    expect(s.has("k1", "n1")).toBe(true);
  });

  test("(keyId, nonce) is a unit: same nonce, different key id is distinct", () => {
    const s = new InMemoryNonceStore();
    s.remember("k1", "shared", DEFAULT_NONCE_RETENTION_MS);
    expect(s.has("k1", "shared")).toBe(true);
    expect(s.has("k2", "shared")).toBe(false);
  });

  test("entry expires after its ttl (lazy expiry on has)", () => {
    let now = 1_000_000;
    const s = new InMemoryNonceStore({ now: () => now });
    s.remember("k", "n", 600_000); // retain 600s
    expect(s.has("k", "n")).toBe(true);
    now += 599_000;
    expect(s.has("k", "n")).toBe(true); // still inside window
    now += 2_000; // now past 600s
    expect(s.has("k", "n")).toBe(false);
  });

  test("periodic sweep prunes expired entries to bound memory", () => {
    let now = 0;
    const s = new InMemoryNonceStore({ now: () => now, sweepIntervalMs: 1_000 });
    s.remember("k", "a", 100); // expires at 100
    expect(s.size).toBe(1);
    now = 2_000; // past sweep interval and past entry expiry
    s.remember("k", "b", 100); // triggers a sweep, dropping "a"
    expect(s.has("k", "a")).toBe(false);
    expect(s.size).toBe(1); // only "b" remains
  });

  test("default retention is at least 600s", () => {
    expect(DEFAULT_NONCE_RETENTION_MS).toBeGreaterThanOrEqual(600_000);
  });
});
