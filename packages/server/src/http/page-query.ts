/**
 * The §7.2 paging query params, parsed once for every paged REST listing.
 * `direction` is `forward` only when it says so (any other value is
 * `backward`, the default). `limit` is parsed as a whole number string,
 * rounded down and clamped to 100; a missing, non-numeric or non-positive
 * value is left out so the listing's pager applies its default. None of these
 * are errors (§7.2).
 */
import type { Context } from "hono";
import type { AppBindings } from "./types.ts";

/** Parsed `cursor` / `direction` / `limit` for a paged read. */
export interface PageQuery {
  readonly cursor: string | null;
  readonly direction: "backward" | "forward";
  readonly limit?: number;
}

/** The §7.2 maximum page size; a larger `limit` is clamped to it. */
export const MAX_PAGE_LIMIT = 100;

/**
 * A plain decimal number, optionally signed, with an optional fraction and
 * exponent (`50`, `2.9`, `.5`, `1e3`, `-5`). The whole string must match, so
 * trailing garbage (`150abc`) makes the value non-numeric. Hex, `Infinity` and
 * other forms `Number()` would accept are deliberately excluded.
 */
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse a §7.2 `limit` query value. A larger value is clamped to 100 and a
 * fractional value is rounded down; a missing, non-numeric or non-positive
 * value (including one that rounds down to 0) yields `undefined`, meaning the
 * listing's default.
 */
export function parsePageLimit(raw: string | undefined): number | undefined {
  const text = raw?.trim() ?? "";
  if (!DECIMAL_NUMBER.test(text)) return undefined;
  const limit = Math.floor(Number(text));
  if (!(limit >= 1)) return undefined;
  return Math.min(limit, MAX_PAGE_LIMIT);
}

/** Parse `cursor` / `direction` / `limit` query params for a paged read. */
export function pageQuery(c: Context<AppBindings>): PageQuery {
  const cursor = c.req.query("cursor") ?? null;
  const direction = c.req.query("direction") === "forward" ? "forward" : "backward";
  const limit = parsePageLimit(c.req.query("limit"));
  return { cursor, direction, ...(limit !== undefined ? { limit } : {}) };
}
