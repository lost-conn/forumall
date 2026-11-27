/**
 * ISO base media files (ISO/IEC 14496-12): MP4, M4A, QuickTime, 3GPP, AVIF and
 * HEIF — a sequence of boxes, the first an `ftyp` box naming the file's brands.
 *
 * A file is confirmed only when its `ftyp` box is well formed (a small,
 * 4-aligned size that fits the file, printable brand codes) and is followed by
 * a second well-formed box. A box size small enough for an `ftyp` box has
 * zero high bytes, which text never contains.
 */
import { type SniffedType, fourcc, sniffed, u32 } from "./common.ts";

/** A box header: its type, where its payload starts and where the box ends. */
export interface Box {
  readonly type: string;
  readonly payload: number;
  readonly end: number;
}

/**
 * The box whose header starts at `offset`, or `null` when there is no
 * complete, well-formed header there or the box runs past the end of `bytes`.
 * A size of `0` (box extends to the end) and the 64-bit `largesize` form are
 * read as ISO/IEC 14496-12 §4.2 defines them.
 */
export function readBox(bytes: Uint8Array, offset: number): Box | null {
  const size = u32(bytes, offset);
  const type = fourcc(bytes, offset + 4);
  if (size === null || type === null) return null;
  if (size === 0) return { type, payload: offset + 8, end: bytes.length };
  if (size === 1) {
    const high = u32(bytes, offset + 8);
    const low = u32(bytes, offset + 12);
    // A box larger than 4 GiB cannot fit an upload; a smaller one must still hold its header.
    if (high !== 0 || low === null || low < 16 || offset + low > bytes.length) return null;
    return { type, payload: offset + 16, end: offset + low };
  }
  if (size < 8 || offset + size > bytes.length) return null;
  return { type, payload: offset + 8, end: offset + size };
}

/** The largest `ftyp` box accepted: far more brands than any real file lists. */
const MAX_FTYP_BYTES = 512;

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
 * The major and compatible brands of the `ftyp` box at offset 0, or `null`
 * when the file does not start with a well-formed one followed by another box.
 */
export function ftypBrands(bytes: Uint8Array): string[] | null {
  const box = readBox(bytes, 0);
  if (box?.type !== "ftyp") return null;
  const size = box.end;
  // size(4) type(4) major_brand(4) minor_version(4), then compatible brands.
  if (size < 16 || size > MAX_FTYP_BYTES || size % 4 !== 0) return null;
  const brands: string[] = [];
  for (let off = 8; off < size; off += 4) {
    if (off === 12) continue; // minor_version, not a brand
    const brand = fourcc(bytes, off);
    if (brand === null) return null;
    brands.push(brand);
  }
  return readBox(bytes, size) === null ? null : brands;
}

/**
 * An ISO base media file. Image brands confirm the image types; any other
 * ISO-BMFF file confirms the movie types.
 */
export function sniffIsoBmff(bytes: Uint8Array): SniffedType | null {
  const brands = ftypBrands(bytes);
  if (brands === null) return null;
  const has = (set: ReadonlySet<string>) => brands.some((b) => set.has(b));
  if (has(AVIF_BRANDS)) return sniffed("image/avif");
  if (has(HEIC_BRANDS)) return sniffed("image/heic", "image/heif", "image/heic-sequence");
  if (has(HEIF_BRANDS)) return sniffed("image/heif", "image/heif-sequence");
  // JPEG XL's container is ISO-BMFF-like but starts with its own signature box (`image.ts`).
  if (brands.includes("jxl ")) return null;
  const major = brands[0] ?? "";
  if (major === "qt  ") return sniffed("video/quicktime", ...ISO_MOVIE_TYPES);
  if (M4A_BRANDS.has(major)) return sniffed("audio/mp4", ...ISO_MOVIE_TYPES);
  if (major.startsWith("3g2")) return sniffed("video/3gpp2", ...ISO_MOVIE_TYPES);
  if (major.startsWith("3gp")) return sniffed("video/3gpp", ...ISO_MOVIE_TYPES);
  return sniffed("video/mp4", ...ISO_MOVIE_TYPES);
}
