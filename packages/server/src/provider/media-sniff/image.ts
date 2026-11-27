/**
 * Raster image formats a browser renders inline: PNG, JPEG, GIF, BMP, ICO,
 * TIFF and JPEG XL (ISO-BMFF images — AVIF, HEIF — are in `iso-bmff.ts`, WebP
 * in `riff-iff.ts`).
 *
 * Each check reads past the signature into the format's header structure
 * (chunk lengths, segment markers, block terminators, directory entries) so
 * that a file is confirmed only when it is laid out as that format is. Those
 * structures need zero or high bytes where text has none.
 */
import { type SniffedType, hasAscii, hasBytes, sniffed, u16, u32 } from "./common.ts";
import { readBox } from "./iso-bmff.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG: the signature, then a complete `IHDR` chunk (length 13) with non-zero dimensions. */
function sniffPng(bytes: Uint8Array): SniffedType | null {
  if (!hasBytes(bytes, 0, PNG_SIGNATURE)) return null;
  // signature(8) length(4) "IHDR"(4) data(13) crc(4)
  if (bytes.length < 33 || u32(bytes, 8) !== 13 || !hasAscii(bytes, 12, "IHDR")) return null;
  if (u32(bytes, 16) === 0 || u32(bytes, 20) === 0) return null;
  return sniffed("image/png", "image/apng");
}

/**
 * JPEG: SOI, then a first marker segment whose length fits the file and is
 * followed by another marker (ITU-T T.81 §B.1).
 */
function sniffJpeg(bytes: Uint8Array): SniffedType | null {
  if (!hasBytes(bytes, 0, [0xff, 0xd8, 0xff])) return null;
  const marker = bytes[3];
  // Markers after SOI that carry a length: 0xC0–0xFE, except RSTn/SOI/EOI (0xD0–0xD9).
  if (marker === undefined || marker < 0xc0 || marker === 0xff) return null;
  if (marker >= 0xd0 && marker <= 0xd9) return null;
  const length = u16(bytes, 4);
  if (length === null || length < 2) return null;
  if (bytes[4 + length] !== 0xff) return null;
  return sniffed("image/jpeg", "image/pjpeg", "image/jpg");
}

/**
 * The offset after the data sub-blocks starting at `offset` (each a size byte
 * and that many bytes, ended by a zero-size block), or `-1` if they run past
 * the end (GIF89a §15).
 */
function skipGifSubBlocks(bytes: Uint8Array, offset: number): number {
  let at = offset;
  while (at < bytes.length) {
    const size = bytes[at] ?? 0;
    at += 1;
    if (size === 0) return at;
    at += size;
  }
  return -1;
}

/** The size in bytes of a GIF colour table whose flags byte is `packed`, `0` if absent. */
const gifColorTableBytes = (packed: number): number =>
  packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;

/**
 * GIF: the header and logical screen descriptor, then extension blocks up to
 * a complete first image (descriptor, LZW code size, terminated data).
 */
function sniffGif(bytes: Uint8Array): SniffedType | null {
  if (!hasAscii(bytes, 0, "GIF87a") && !hasAscii(bytes, 0, "GIF89a")) return null;
  const screen = bytes[10];
  if (screen === undefined) return null;
  let at = 13 + gifColorTableBytes(screen);
  while (at >= 0 && at < bytes.length) {
    const introducer = bytes[at];
    if (introducer === 0x21) {
      at = skipGifSubBlocks(bytes, at + 2); // introducer, label, sub-blocks
    } else if (introducer === 0x2c) {
      const flags = bytes[at + 9];
      if (flags === undefined) return null;
      at += 10 + gifColorTableBytes(flags);
      const lzwCodeSize = bytes[at];
      if (lzwCodeSize === undefined || lzwCodeSize < 2 || lzwCodeSize > 8) return null;
      return skipGifSubBlocks(bytes, at + 1) < 0 ? null : sniffed("image/gif");
    } else {
      return null; // the trailer or junk before any image
    }
  }
  return null;
}

/** DIB header sizes of the BMP versions (core, info, v2–v5). */
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);
const BMP_BIT_DEPTHS = new Set([1, 2, 4, 8, 16, 24, 32]);

/**
 * BMP: the file header (`BM`, zero reserved fields, a pixel offset past the
 * headers and inside the file), then a DIB header of a known size with one
 * plane and a valid bit depth.
 */
function sniffBmp(bytes: Uint8Array): SniffedType | null {
  if (!hasAscii(bytes, 0, "BM") || u32(bytes, 6, true) !== 0) return null;
  const dibSize = u32(bytes, 14, true);
  const pixels = u32(bytes, 10, true);
  if (dibSize === null || pixels === null || !BMP_DIB_SIZES.has(dibSize)) return null;
  if (pixels < 14 + dibSize || pixels > bytes.length) return null;
  const planesAt = dibSize === 12 ? 22 : 26;
  if (u16(bytes, planesAt, true) !== 1) return null;
  if (!BMP_BIT_DEPTHS.has(u16(bytes, planesAt + 2, true) ?? 0)) return null;
  return sniffed("image/bmp", "image/x-bmp", "image/x-ms-bmp");
}

const ICO_BIT_DEPTHS = new Set([0, 1, 2, 4, 8, 16, 24, 32]);

/**
 * ICO: the icon directory (reserved 0, type 1, a non-zero count) and every
 * directory entry well formed, its image inside the file and starting with a
 * PNG signature or a BITMAPINFOHEADER.
 */
function sniffIco(bytes: Uint8Array): SniffedType | null {
  if (u16(bytes, 0, true) !== 0 || u16(bytes, 2, true) !== 1) return null;
  const count = u16(bytes, 4, true);
  if (count === null || count === 0) return null;
  const directoryEnd = 6 + 16 * count;
  if (directoryEnd > bytes.length) return null;
  for (let entry = 6; entry < directoryEnd; entry += 16) {
    const planes = u16(bytes, entry + 4, true) ?? 2;
    const depth = u16(bytes, entry + 6, true) ?? -1;
    const size = u32(bytes, entry + 8, true) ?? 0;
    const offset = u32(bytes, entry + 12, true) ?? 0;
    if (bytes[entry + 3] !== 0 || planes > 1 || !ICO_BIT_DEPTHS.has(depth)) return null;
    if (size === 0 || offset < directoryEnd || offset + size > bytes.length) return null;
    if (!hasBytes(bytes, offset, PNG_SIGNATURE) && u32(bytes, offset, true) !== 40) return null;
  }
  return sniffed("image/x-icon", "image/vnd.microsoft.icon");
}

/**
 * TIFF: the byte-order header, then a first image file directory inside the
 * file with at least one entry, entries in ascending tag order with valid
 * field types (TIFF 6.0 §2).
 */
function sniffTiff(bytes: Uint8Array): SniffedType | null {
  const le = hasBytes(bytes, 0, [0x49, 0x49, 0x2a, 0x00]);
  if (!le && !hasBytes(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) return null;
  const ifd = u32(bytes, 4, le);
  if (ifd === null || ifd < 8) return null;
  const count = u16(bytes, ifd, le);
  if (count === null || count === 0 || ifd + 2 + 12 * count + 4 > bytes.length) return null;
  let previousTag = -1;
  for (let entry = ifd + 2; entry < ifd + 2 + 12 * count; entry += 12) {
    const tag = u16(bytes, entry, le) ?? -1;
    const type = u16(bytes, entry + 2, le) ?? 0;
    if (tag <= previousTag || type < 1 || type > 13) return null;
    previousTag = tag;
  }
  return sniffed("image/tiff");
}

const JXL_SIGNATURE_BOX = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

/**
 * JPEG XL in its container (ISO/IEC 18181-2): the signature box, an `ftyp`
 * box of brand `jxl `, then well-formed boxes up to a codestream box (`jxlc`
 * or `jxlp`).
 *
 * A bare JPEG XL codestream is never confirmed: it starts with just two
 * signature bytes, and the size header after them is a bit-packed field any
 * byte values satisfy, so nothing more of its structure can be checked
 * without decoding. It is stored as `application/octet-stream`.
 */
function sniffJxl(bytes: Uint8Array): SniffedType | null {
  if (!hasBytes(bytes, 0, JXL_SIGNATURE_BOX)) return null;
  const ftyp = readBox(bytes, 12);
  if (ftyp?.type !== "ftyp" || !hasAscii(bytes, ftyp.payload, "jxl ")) return null;
  let at = ftyp.end;
  while (at < bytes.length) {
    const box = readBox(bytes, at);
    if (box === null) return null;
    if (box.type === "jxlc" || box.type === "jxlp") return sniffed("image/jxl");
    at = box.end;
  }
  return null;
}

/** The image format checks, in the order the sniffer tries them. */
export const IMAGE_SNIFFERS = [
  sniffPng,
  sniffJpeg,
  sniffGif,
  sniffBmp,
  sniffIco,
  sniffTiff,
  sniffJxl,
] as const;
