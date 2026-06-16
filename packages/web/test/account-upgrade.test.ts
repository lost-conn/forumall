/**
 * Pure-function coverage for the guest-claim form validation (§4.8). DOM-free, so
 * it runs in Bun without a browser env. Mirrors the server's §4.1 handle rules:
 * format (3–32 lowercase alnum / '_' / '-'), no reserved `guest_` prefix, password
 * ≥ 8 chars, and passwords must match.
 */
import { describe, expect, test } from "bun:test";
import { validateClaimForm } from "../src/lib/account-upgrade.ts";

const VALID = {
  handle: "alice_01",
  password: "longenough",
  confirmPassword: "longenough",
};

describe("validateClaimForm", () => {
  test("a valid handle + matching ≥8-char passwords → null (no error)", () => {
    expect(validateClaimForm(VALID)).toBeNull();
  });

  test("empty handle → error", () => {
    expect(validateClaimForm({ ...VALID, handle: "" })).toBe("Choose a handle.");
  });

  test("guest_-prefixed handle is rejected", () => {
    const msg = validateClaimForm({ ...VALID, handle: "guest_abcd" });
    expect(msg).toContain("guest_");
  });

  test("too-short handle → error", () => {
    expect(validateClaimForm({ ...VALID, handle: "ab" })).toContain("3–32");
  });

  test("handle with illegal chars (uppercase/space) → error", () => {
    expect(validateClaimForm({ ...VALID, handle: "Alice One" })).toContain("3–32");
  });

  test("password under 8 chars → error", () => {
    const msg = validateClaimForm({ handle: "alice", password: "short", confirmPassword: "short" });
    expect(msg).toBe("Password must be at least 8 characters.");
  });

  test("mismatched passwords → error", () => {
    const msg = validateClaimForm({ ...VALID, confirmPassword: "different1" });
    expect(msg).toBe("Passwords don't match.");
  });
});
