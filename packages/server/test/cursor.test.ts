/**
 * The shared §7.2 opaque cursor (`provider/cursor.ts`): a round trip returns
 * the position, and anything a client could forge — not base64url JSON, or a
 * position of the wrong shape — decodes to `null` (the listing then serves its
 * first page) instead of reaching a query.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { decodeCursor, encodeCursor } from "../src/provider/cursor.ts";

const Position = z.object({ createdAt: z.number().int(), id: z.string() });
const b64 = (json: string) => Buffer.from(json, "utf8").toString("base64url");

describe("opaque cursor codec (§7.2)", () => {
  test("round-trips a position as an unpadded base64url string", () => {
    const cursor = encodeCursor({ createdAt: 1_700_000_000_123, id: "rxn_é/+" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, Position)).toEqual({ createdAt: 1_700_000_000_123, id: "rxn_é/+" });
  });

  test.each([
    ["not base64url JSON", "!!!"],
    ["a JSON number", b64("5")],
    ["JSON null", b64("null")],
    ["a field of the wrong type", b64('{"createdAt":"x","id":"a"}')],
    ["a non-integer number", b64('{"createdAt":1.5,"id":"a"}')],
    ["a missing field", b64('{"createdAt":1}')],
  ])("a forged cursor (%s) decodes to null", (_label, cursor) => {
    expect(decodeCursor(cursor, Position)).toBeNull();
  });
});
