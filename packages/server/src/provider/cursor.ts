/**
 * The §7.2 opaque pagination cursor, shared by every keyset-paginated listing
 * (members, messages, reactions, notifications, the discover feed).
 *
 * A cursor is a keyset position, JSON-serialized and base64url-encoded: an
 * opaque string to clients (§7.2 "Pagination cursors MUST be opaque strings
 * returned by the server"), a decodable position to the server. Because the
 * client hands it back, a cursor is untrusted input: {@link decodeCursor}
 * validates the decoded position against the listing's own schema, so a
 * malformed or forged cursor yields `null` (the caller serves the first page)
 * rather than an ill-typed position reaching a query.
 */
import type { z } from "zod";

/** Encode a keyset position as an opaque base64url cursor (§7.2). */
export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/**
 * Decode a cursor produced by {@link encodeCursor} and validate its position
 * with `schema`. Returns `null` when the cursor is not base64url JSON or its
 * position does not match `schema`.
 */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T | null {
  let position: unknown;
  try {
    position = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(position);
  return parsed.success ? parsed.data : null;
}
