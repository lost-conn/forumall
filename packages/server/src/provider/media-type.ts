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
 * The sniffer reads only magic bytes and container headers (pure JS, no
 * decoding library), and only for formats a browser can render inline. A
 * format it does not know is never confirmed, so it is stored as
 * `application/octet-stream` and downloaded rather than rendered: the safe
 * direction to be wrong in.
 */
import { MimeTypeSchema } from "@forumall/shared";

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

/** A format the bytes were recognized as. */
export interface SniffedType {
  /** The type to record when the uploader declared none. */
  readonly primary: string;
  /** Every media type (aliases included) these bytes confirm; `primary` is first. */
  readonly types: readonly string[];
}

const sniffed = (primary: string, ...aliases: string[]): SniffedType => ({
  primary,
  types: [primary, ...aliases],
});

/** Whether `bytes` holds `sig` starting at `offset`. */
function hasBytes(bytes: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (offset + sig.length > bytes.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** Whether `bytes` holds the ASCII string `text` starting at `offset`. */
function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  return hasBytes(
    bytes,
    offset,
    Array.from(text, (ch) => ch.charCodeAt(0)),
  );
}

/** The 4-character code at `offset` (ASCII), or `null` past the end. */
function fourcc(bytes: Uint8Array, offset: number): string | null {
  if (offset + 4 > bytes.length) return null;
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** ISO-BMFF brands that mark an AVIF image (AV1 image file format). */
const AVIF_BRANDS = new Set(["avif", "avis"]);
/** ISO-BMFF brands that mark a HEIF/HEIC image. */
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
/** ISO-BMFF brands of audio-only MPEG-4 files. */
const M4A_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B "]);
/** The audio and video types an ISO-BMFF movie file (MP4, QuickTime, 3GPP) confirms. */
const ISO_MOVIE_TYPES = [
  "video/mp4",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "video/x-m4v",
  "video/quicktime",
  "video/3gpp",
  "audio/3gpp",
  "video/3gpp2",
  "audio/3gpp2",
];

/**
 * An ISO base media file (MP4, M4A, QuickTime, 3GPP, AVIF, HEIF): a leading
 * `ftyp` box naming its major brand and compatible brands (ISO/IEC 14496-12
 * §4.3). Image brands confirm the image types; any other ISO-BMFF file
 * confirms the movie types.
 */
function sniffIsoBmff(bytes: Uint8Array): SniffedType | null {
  if (!hasAscii(bytes, 4, "ftyp") || bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxSize = view.getUint32(0);
  // size(4) type(4) major_brand(4) minor_version(4), then compatible brands.
  if (boxSize < 16 || boxSize % 4 !== 0) return null;
  const brands: string[] = [];
  for (let off = 8; off + 4 <= Math.min(boxSize, bytes.length); off += 4) {
    if (off === 12) continue; // minor_version, not a brand
    const brand = fourcc(bytes, off);
    if (brand !== null) brands.push(brand);
  }
  const has = (set: ReadonlySet<string>) => brands.some((b) => set.has(b));
  if (has(AVIF_BRANDS)) return sniffed("image/avif");
  if (has(HEIC_BRANDS)) return sniffed("image/heic", "image/heif", "image/heic-sequence");
  if (has(HEIF_BRANDS)) return sniffed("image/heif", "image/heif-sequence");
  const major = brands[0] ?? "";
  if (major === "qt  ") return sniffed("video/quicktime", ...ISO_MOVIE_TYPES);
  if (M4A_BRANDS.has(major)) return sniffed("audio/mp4", ...ISO_MOVIE_TYPES);
  if (major.startsWith("3g2")) return sniffed("video/3gpp2", ...ISO_MOVIE_TYPES);
  if (major.startsWith("3gp")) return sniffed("video/3gpp", ...ISO_MOVIE_TYPES);
  return sniffed("video/mp4", ...ISO_MOVIE_TYPES);
}

/** A RIFF container (`RIFF` <size> <form type>): WebP, WAV or AVI. */
function sniffRiff(bytes: Uint8Array): SniffedType | null {
  if (!hasAscii(bytes, 0, "RIFF")) return null;
  switch (fourcc(bytes, 8)) {
    case "WEBP":
      return sniffed("image/webp");
    case "WAVE":
      return sniffed("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave");
    case "AVI ":
      return sniffed("video/x-msvideo", "video/avi", "video/msvideo");
    default:
      return null;
  }
}

/**
 * An MPEG audio stream starting at a frame header: an ADTS (AAC) frame, or an
 * MPEG-1/2/2.5 Layer I–III (MP3) frame with a valid bitrate and sample rate.
 */
function sniffMpegAudioFrame(bytes: Uint8Array): SniffedType | null {
  const [b0, b1, b2] = bytes;
  if (b0 !== 0xff || b1 === undefined || b2 === undefined || (b1 & 0xe0) !== 0xe0) return null;
  // ADTS: 12-bit sync, ID, then layer `00`.
  if ((b1 & 0xf6) === 0xf0) return sniffed("audio/aac", "audio/x-aac", "audio/aacp");
  const version = (b1 >> 3) & 0b11; // 01 is reserved
  const layer = (b1 >> 1) & 0b11; // 00 is reserved (outside ADTS)
  const bitrate = b2 >> 4; // 1111 is invalid
  const sampleRate = (b2 >> 2) & 0b11; // 11 is reserved
  if (version === 0b01 || layer === 0 || bitrate === 0xf || sampleRate === 0b11) return null;
  return sniffed("audio/mpeg", "audio/mp3", "audio/mpeg3");
}

/** An EBML document (Matroska or WebM, by its DocType). */
function sniffEbml(bytes: Uint8Array): SniffedType | null {
  if (!hasBytes(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return null;
  const types = ["video/webm", "audio/webm", "video/x-matroska", "audio/x-matroska"];
  // The DocType ("webm" / "matroska") sits in the EBML header, within its first bytes.
  const header = String.fromCharCode(...bytes.subarray(0, 64));
  const primary = header.includes("webm") ? "video/webm" : "video/x-matroska";
  return sniffed(primary, ...types.filter((t) => t !== primary));
}

/** Fixed-signature formats, checked in order. */
const SIGNATURES: readonly ((bytes: Uint8Array) => SniffedType | null)[] = [
  (b) =>
    hasBytes(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? sniffed("image/png", "image/apng")
      : null,
  (b) =>
    hasBytes(b, 0, [0xff, 0xd8, 0xff]) ? sniffed("image/jpeg", "image/pjpeg", "image/jpg") : null,
  (b) => (hasAscii(b, 0, "GIF87a") || hasAscii(b, 0, "GIF89a") ? sniffed("image/gif") : null),
  // BMP: "BM", then a 4-byte file size and 4 reserved bytes that are zero.
  (b) =>
    b.length >= 26 && hasAscii(b, 0, "BM") && hasBytes(b, 6, [0, 0, 0, 0])
      ? sniffed("image/bmp", "image/x-bmp", "image/x-ms-bmp")
      : null,
  // ICO: reserved 0, type 1, then a non-zero image count.
  (b) =>
    hasBytes(b, 0, [0x00, 0x00, 0x01, 0x00]) && b.length >= 6 && (b[4] !== 0 || b[5] !== 0)
      ? sniffed("image/x-icon", "image/vnd.microsoft.icon")
      : null,
  (b) =>
    hasBytes(b, 0, [0x49, 0x49, 0x2a, 0x00]) || hasBytes(b, 0, [0x4d, 0x4d, 0x00, 0x2a])
      ? sniffed("image/tiff")
      : null,
  // JPEG XL: a bare codestream, or the ISO-BMFF-style container signature box.
  (b) =>
    hasBytes(b, 0, [0xff, 0x0a]) ||
    hasBytes(b, 0, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
      ? sniffed("image/jxl")
      : null,
  sniffIsoBmff,
  sniffRiff,
  sniffEbml,
  (b) => (hasAscii(b, 0, "OggS") ? sniffed("audio/ogg", "video/ogg", "audio/opus") : null),
  (b) => (hasAscii(b, 0, "fLaC") ? sniffed("audio/flac", "audio/x-flac") : null),
  (b) =>
    hasAscii(b, 0, "FORM") && (hasAscii(b, 8, "AIFF") || hasAscii(b, 8, "AIFC"))
      ? sniffed("audio/aiff", "audio/x-aiff")
      : null,
  (b) => (hasAscii(b, 0, "MThd") ? sniffed("audio/midi", "audio/x-midi", "audio/mid") : null),
  (b) => (hasAscii(b, 0, "#!AMR") ? sniffed("audio/amr") : null),
  // An ID3v2 tag ("ID3", major version, revision) in front of MP3 frames.
  (b) =>
    hasAscii(b, 0, "ID3") && b.length >= 10 && b[3] !== 0xff && b[4] !== 0xff
      ? sniffed("audio/mpeg", "audio/mp3", "audio/mpeg3")
      : null,
  sniffMpegAudioFrame,
  // MPEG program stream pack header, or an MPEG video sequence header.
  (b) =>
    hasBytes(b, 0, [0x00, 0x00, 0x01, 0xba]) || hasBytes(b, 0, [0x00, 0x00, 0x01, 0xb3])
      ? sniffed("video/mpeg")
      : null,
  // MPEG transport stream: the 0x47 sync byte at the start of two 188-byte packets.
  (b) => (b.length > 188 && b[0] === 0x47 && b[188] === 0x47 ? sniffed("video/mp2t") : null),
];

/**
 * The renderable media format `bytes` is, read from its magic bytes, or `null`
 * when it is none this sniffer knows. Never throws.
 */
export function sniffMediaType(bytes: Uint8Array): SniffedType | null {
  for (const signature of SIGNATURES) {
    const match = signature(bytes);
    if (match !== null) return match;
  }
  return null;
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
