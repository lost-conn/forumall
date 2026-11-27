/**
 * The opaque §7.2 cursor codec shared by every keyset-paginated listing
 * (members, messages, DMs, reactions, notifications, discover, invites, join
 * requests): a keyset position is JSON-serialized then base64url-encoded, so a
 * cursor is opaque to clients but a stable, decodable keyset to the server.
 */

/** Base64url-encode (URL-safe, no padding). */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Encode an arbitrary keyset position as an opaque base64url cursor (§7.2).
 * The position is JSON-serialized then base64url-encoded, so the cursor is an
 * opaque string to clients but a stable, decodable keyset to the server. Reuse
 * this for any keyset-paginated list (members, messages, DMs).
 */
export function encodeCursor(position: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(position)));
}

/**
 * Decode an opaque cursor produced by {@link encodeCursor} back into its keyset
 * position, or `null` if it is malformed (a forged/garbage cursor is treated as
 * "no cursor" by the caller rather than crashing).
 */
export function decodeCursor<T>(cursor: string): T | null {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
