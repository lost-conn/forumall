import { describe, expect, test } from "bun:test";
import { deriveDmId } from "../src/dm.ts";

// Spec §7.4 known vector: `alice@a.com` + `bob@b.com`.
const VECTOR_A = "alice@a.com";
const VECTOR_B = "bob@b.com";
const VECTOR_ID =
  "dm_c2a3a0d4bc7aa54700d2f412c42fc0155df6071e502977e4988933eef7e46868";

describe("deriveDmId", () => {
  test("reproduces the spec §7.4 vector", () => {
    expect(deriveDmId(VECTOR_A, VECTOR_B)).toBe(VECTOR_ID);
  });

  test("is order-independent", () => {
    expect(deriveDmId(VECTOR_A, VECTOR_B)).toBe(deriveDmId(VECTOR_B, VECTOR_A));
  });

  test("case-folds mixed-case inputs to the lowercase vector", () => {
    expect(deriveDmId("Alice@A.com", "BOB@b.com")).toBe(VECTOR_ID);
    expect(deriveDmId("BOB@B.COM", "ALICE@A.COM")).toBe(VECTOR_ID);
  });

  test("trims surrounding whitespace", () => {
    expect(deriveDmId("  alice@a.com ", "\tbob@b.com\n")).toBe(VECTOR_ID);
  });

  test("matches the dmId shape", () => {
    expect(deriveDmId(VECTOR_A, VECTOR_B)).toMatch(/^dm_[0-9a-f]{64}$/);
  });

  test("throws on empty input", () => {
    expect(() => deriveDmId("", VECTOR_B)).toThrow();
    expect(() => deriveDmId(VECTOR_A, "   ")).toThrow();
  });

  test("throws on input missing @", () => {
    expect(() => deriveDmId("alice", VECTOR_B)).toThrow();
    expect(() => deriveDmId(VECTOR_A, "bob.b.com")).toThrow();
  });
});
