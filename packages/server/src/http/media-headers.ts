/**
 * Response headers for serving an attachment (spec §5.8 "Serving attachments").
 *
 * Attachment URLs are capability URLs served from the provider's own origin
 * (the same origin as the web client), and the stored `mime` is the uploader's
 * declared type. So every response is hardened against a file being run as a
 * page of that origin:
 *
 *  - `Content-Disposition: attachment` for every type except `image/*`,
 *    `video/*` and `audio/*`, and always for `image/svg+xml` (which can carry
 *    script) — the §5.8 MUST. A browser opening such a `url` downloads it.
 *  - `Content-Security-Policy: sandbox` on every response, the §5.8 "allowed
 *    alternative", sent here in addition: an inline type opened directly (or a
 *    file whose bytes don't match its declared type) still gets a sandboxed,
 *    script-less, opaque-origin document. It does not affect `<img>`/`<video>`
 *    loads, since a subresource's own CSP never applies to it.
 *  - `X-Content-Type-Options: nosniff` on every response (§5.8 SHOULD), so the
 *    browser never reinterprets the bytes as a more dangerous type.
 *
 * Caching (§5.8 SHOULD NOT): this provider cannot know that every message
 * referencing an upload is publicly readable (it may be posted to a remote
 * channel or a DM), so attachments are never publicly cacheable:
 * `Cache-Control: private` plus the `max-age` and `immutable` §5.8 allows (the
 * bytes behind a `url` never change). The strong `ETag` is the stored
 * `sha-256` content hash, which identifies exactly those bytes.
 */
import type { MediaRow } from "../db/schema.ts";

/** `Cache-Control` for an attachment: private (never shared caches), immutable. */
export const MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** `Content-Security-Policy` for an attachment (§5.8's sandbox alternative). */
export const MEDIA_CSP = "sandbox";

/**
 * Whether a browser may render `mime` inline: `image/*`, `video/*` and
 * `audio/*`, except `image/svg+xml`. Media types are case-insensitive
 * (RFC 9110 §8.3.1), so the comparison is too.
 */
export function rendersInline(mime: string): boolean {
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/svg+xml") return false;
  return type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/");
}

/**
 * Characters RFC 8187 §3.2.1 allows unencoded in an `ext-value` (`attr-char`).
 * Everything else is percent-encoded as UTF-8.
 */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

/** RFC 8187 `ext-value` for `value`: `UTF-8''` + percent-encoded UTF-8. */
function extValue(value: string): string {
  let out = "UTF-8''";
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    out +=
      byte < 0x80 && ATTR_CHAR.test(ch)
        ? ch
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * The plain `filename` fallback for `name`: printable ASCII only, without `"`
 * and `\` (which would need quoting rules some browsers get wrong) and `%`
 * (which some browsers percent-decode) — RFC 6266 §4.3 and Appendix D.
 */
function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
}

/**
 * A `Content-Disposition` value (RFC 6266) of disposition `type`, naming the
 * file `filename` when one was uploaded. A name that the plain `filename`
 * parameter cannot carry exactly also gets `filename*` (RFC 8187), which
 * browsers prefer.
 */
export function contentDisposition(
  type: "inline" | "attachment",
  filename: string | null | undefined,
): string {
  if (filename == null || filename.length === 0) return type;
  const wellFormed = filename.toWellFormed();
  const fallback = asciiFallback(wellFormed);
  const plain = `${type}; filename="${fallback}"`;
  return fallback === wellFormed ? plain : `${plain}; filename*=${extValue(wellFormed)}`;
}

/** The strong `ETag` of an attachment: its stored content hash, quoted. */
export function mediaETag(row: Pick<MediaRow, "hash">): string {
  return `"${row.hash}"`;
}

/**
 * Headers sent with an attachment's `304 Not Modified`: the validators and
 * caching headers a `200` would carry (RFC 9110 §15.4.5).
 */
export function mediaNotModifiedHeaders(row: Pick<MediaRow, "hash">): Record<string, string> {
  return {
    etag: mediaETag(row),
    "cache-control": MEDIA_CACHE_CONTROL,
  };
}

/** Every header of an attachment's `200` response (and its `HEAD`). */
export function mediaResponseHeaders(
  row: Pick<MediaRow, "mime" | "size" | "filename" | "hash">,
): Record<string, string> {
  const inline = rendersInline(row.mime);
  const headers: Record<string, string> = {
    "content-type": row.mime,
    "content-length": String(row.size),
    ...mediaNotModifiedHeaders(row),
    "content-security-policy": MEDIA_CSP,
    "x-content-type-options": "nosniff",
  };
  if (!inline) {
    headers["content-disposition"] = contentDisposition("attachment", row.filename);
  } else if (row.filename != null && row.filename.length > 0) {
    // Inline types render in place; the filename still names a "Save as".
    headers["content-disposition"] = contentDisposition("inline", row.filename);
  }
  return headers;
}
