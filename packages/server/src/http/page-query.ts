/**
 * The §7.2 paging query params, parsed once for every paged REST listing.
 * `direction` is `forward` only when it says so (any other value is
 * `backward`, the default); `limit` is passed on only when it is a positive
 * number, and the listing's pager applies the default, the clamp to 100 and
 * the rounding down. None of these are errors (§7.2).
 */
import type { Context } from "hono";
import type { AppBindings } from "./types.ts";

/** Parsed `cursor` / `direction` / `limit` for a paged read. */
export interface PageQuery {
  readonly cursor: string | null;
  readonly direction: "backward" | "forward";
  readonly limit?: number;
}

/** Parse `cursor` / `direction` / `limit` query params for a paged read. */
export function pageQuery(c: Context<AppBindings>): PageQuery {
  const cursor = c.req.query("cursor") ?? null;
  const direction = c.req.query("direction") === "forward" ? "forward" : "backward";
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  return { cursor, direction, ...(limit !== undefined ? { limit } : {}) };
}
