/**
 * Read an optional JSON request body: an absent or whitespace-only body is
 * valid and is not checked against the schema; any other body must be JSON
 * that the schema accepts, else `400 bad_request`. Used by `PUT
 * …/reactions/{key}` (§7.1, `reaction-put-request.json`); the group join route
 * (§5.7) reuses {@link parseJsonText}, since it checks its schema only under the
 * `request` policy.
 */
import type { Context } from "hono";
import type { ZodType } from "zod";

import { AppError, parseRequestBody } from "./errors.ts";
import type { AppBindings } from "./types.ts";

/**
 * Parse the request's optional body with `schema`. Returns `undefined` for an
 * absent or whitespace-only body; otherwise the parsed body, unknown fields
 * preserved (§2.3). Throws `400` naming `what` when the body is not JSON or
 * does not match.
 */
export async function readOptionalBody<T>(
  c: Context<AppBindings>,
  schema: ZodType<T>,
  what: string,
): Promise<T | undefined> {
  const text = await c.req.text();
  if (text.trim().length === 0) return undefined;
  return parseRequestBody(schema, parseJsonText(text, what), what);
}

/** Parse `text` as JSON, or throw `400` naming `what`. */
export function parseJsonText(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw AppError.badRequest({ detail: `${what} is not valid JSON` });
  }
}
