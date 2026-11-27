/**
 * The `mime` an upload is stored with (spec §5.8, `POST /api/media`).
 *
 * §5.8 lets the provider record the declared type of the `file` part, but not a
 * type that clients show inline and browsers render — `image/*` other than
 * `image/svg+xml`, `video/*`, `audio/*` ({@link rendersInline}) — unless the
 * stored bytes confirm it. When it cannot confirm such a type, or determines no
 * type at all, it records `application/octet-stream`. So:
 *
 *  - a declared type that is not inline (`text/plain`, `application/pdf`,
 *    `image/svg+xml`, …) is recorded as declared (lowercased, parameters
 *    stripped): the serving headers already make a browser download it;
 *  - a declared inline type is recorded only when {@link sniffMediaType} reads
 *    the bytes as a format that type names, else `application/octet-stream`;
 *  - no (or an unparsable) declared type records what the bytes are, when the
 *    sniffer recognizes them, else `application/octet-stream`.
 *
 * The sniffer (`media-sniff/`) confirms a format only by checking its
 * structure — header fields, sizes that fit, the next box, chunk or frame —
 * never by magic bytes alone, so text cannot pass for media on either path.
 * A format it cannot check is never confirmed, so it is stored as
 * `application/octet-stream` and downloaded rather than rendered: the safe
 * direction to be wrong in.
 */
import { MimeTypeSchema } from "@forumall/shared";

import { sniffMediaType } from "./media-sniff/index.ts";

export { type SniffedType, sniffMediaType } from "./media-sniff/index.ts";

/** The type recorded when no safe, specific type can be determined (§5.8). */
export const OCTET_STREAM = "application/octet-stream";

/** The `type/subtype` of `raw`, lowercased, without parameters; `null` if not a media type. */
export function mediaTypeEssence(raw: string): string | null {
  const essence = (raw.split(";")[0] ?? "").trim().toLowerCase();
  return MimeTypeSchema.safeParse(essence).success ? essence : null;
}

/**
 * Whether a browser may render `mime` inline: `image/*`, `video/*` and
 * `audio/*`, except `image/svg+xml` (§5.8). Media types are case-insensitive
 * (RFC 9110 §8.3.1), so the comparison is too.
 */
export function rendersInline(mime: string): boolean {
  const type = (mime.split(";")[0] ?? "").trim().toLowerCase();
  if (type === "image/svg+xml") return false;
  return type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/");
}

/**
 * The `mime` to store for an upload whose part declared `declared` (its
 * `Content-Type`, possibly empty) and whose stored bytes are `bytes` (§5.8;
 * see the module doc).
 */
export function determineUploadMime(declared: string, bytes: Uint8Array): string {
  const essence = mediaTypeEssence(declared);
  const sniffedType = sniffMediaType(bytes);
  if (essence === null) return sniffedType?.primary ?? OCTET_STREAM;
  if (!rendersInline(essence)) return essence;
  return sniffedType?.types.includes(essence) ? essence : OCTET_STREAM;
}
