/**
 * The optional body of `PUT …/reactions/{key}` (OFSCP §7.1,
 * `reaction-put-request.json`), shared by the group route, the DM route (§7.4)
 * and the federation DM route (§8.3).
 *
 * The body is optional: an absent or empty body is valid and is NOT checked
 * against the schema. A JSON body is checked, and `{}` is valid. `unicode` and
 * `image` (an `https` URL) are each optional and independent of each other and
 * of the path's `key`. A body that does not match — malformed JSON, a non-object,
 * a non-string `unicode`, a non-`https` `image` — is `400 bad_request`.
 */
import { type ReactionPutRequest, ReactionPutRequestSchema } from "@forumall/shared";
import type { Context } from "hono";

import { AppError, parseRequestBody } from "./errors.ts";
import type { AppBindings } from "./types.ts";

/**
 * Read and validate the optional reaction `PUT` body. Returns `{}` for an
 * absent or whitespace-only body; otherwise the parsed body, unknown fields
 * preserved (§2.3 — the federation route reads the provider-signed `actor`
 * from it). Throws `400` when the body is not JSON or does not match.
 */
export async function readReactionPutBody(c: Context<AppBindings>): Promise<ReactionPutRequest> {
  return parseReactionPutBody(await c.req.text());
}

/**
 * Validate the text of an optional reaction `PUT` body, as
 * {@link readReactionPutBody} does. For a route that must read the body before
 * its earlier checks but judge it only after them (§7.1 "Order of checks":
 * the body rules are step 5).
 */
export function parseReactionPutBody(text: string): ReactionPutRequest {
  if (text.trim().length === 0) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw AppError.badRequest({ detail: "reaction body is not valid JSON" });
  }
  return parseRequestBody(ReactionPutRequestSchema, raw, "reaction body");
}

/** The `unicode`/`image` of a validated body, with absent fields left out. */
export function reactionExtras(body: ReactionPutRequest): { unicode?: string; image?: string } {
  return {
    ...(body.unicode !== undefined ? { unicode: body.unicode } : {}),
    ...(body.image !== undefined ? { image: body.image } : {}),
  };
}
