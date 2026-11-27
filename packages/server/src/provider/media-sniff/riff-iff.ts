/**
 * Chunked containers: RIFF (little-endian — WebP, WAV, AVI) and IFF `FORM`
 * (big-endian — AIFF). A file is confirmed only when its container size fits
 * the file and its chunks are well formed up to the chunk that identifies the
 * content (the WebP bitstream, the WAV `fmt `, the AVI `hdrl` list, the AIFF
 * `COMM`). A container size small enough to fit an upload has a zero high
 * byte, which text never contains.
 */
import { type SniffedType, fourcc, hasAscii, hasBytes, sniffed, u16, u32 } from "./common.ts";

/** A chunk: its id, where its data starts and its data size. */
interface Chunk {
  readonly id: string;
  readonly data: number;
  readonly size: number;
}

/**
 * The chunks between `start` and `end`, in order, each with a printable id
 * and its data inside `end`; iteration stops at the first malformed chunk.
 * Chunk data is padded to an even length (RIFF, EA IFF 85).
 */
function* chunks(bytes: Uint8Array, start: number, end: number, le: boolean): Generator<Chunk> {
  let at = start;
  while (at + 8 <= end) {
    const id = fourcc(bytes, at);
    const size = u32(bytes, at + 4, le);
    if (id === null || size === null || at + 8 + size > end) return;
    yield { id, data: at + 8, size };
    at += 8 + size + (size & 1);
  }
}

/**
 * The form type and chunk area of a container with `magic` (`RIFF`/`FORM`)
 * at offset 0 whose declared size fits the file, or `null`.
 */
function container(
  bytes: Uint8Array,
  magic: string,
  le: boolean,
): { form: string; end: number } | null {
  if (!hasAscii(bytes, 0, magic)) return null;
  const size = u32(bytes, 4, le);
  const form = fourcc(bytes, 8);
  if (size === null || form === null || size < 4 || 8 + size > bytes.length) return null;
  return { form, end: 8 + size };
}

/** The first chunk of a WebP file: a VP8 (lossy), VP8L (lossless) or VP8X (extended) bitstream. */
function isWebpBitstream(bytes: Uint8Array, chunk: Chunk): boolean {
  switch (chunk.id) {
    case "VP8 ": // a key frame's start code (RFC 6386 §9.1)
      return chunk.size >= 10 && hasBytes(bytes, chunk.data + 3, [0x9d, 0x01, 0x2a]);
    case "VP8L": // the lossless signature byte
      return chunk.size >= 5 && bytes[chunk.data] === 0x2f;
    case "VP8X": // a fixed 10-byte header
      return chunk.size === 10;
    default:
      return false;
  }
}

/** A WAV `fmt ` chunk: at least PCMWAVEFORMAT's 16 bytes, a format tag, channels and a rate. */
function isWavFormat(bytes: Uint8Array, chunk: Chunk): boolean {
  if (chunk.id !== "fmt " || chunk.size < 16) return false;
  const formatTag = u16(bytes, chunk.data, true) ?? 0;
  const channels = u16(bytes, chunk.data + 2, true) ?? 0;
  const sampleRate = u32(bytes, chunk.data + 4, true) ?? 0;
  return formatTag !== 0 && channels !== 0 && sampleRate !== 0;
}

/** A RIFF container: WebP, WAV or AVI. */
function sniffRiff(bytes: Uint8Array): SniffedType | null {
  const riff = container(bytes, "RIFF", true);
  if (riff === null) return null;
  const all = chunks(bytes, 12, riff.end, true);
  switch (riff.form) {
    case "WEBP": {
      const first = all.next();
      return !first.done && isWebpBitstream(bytes, first.value) ? sniffed("image/webp") : null;
    }
    case "WAVE":
      for (const chunk of all) {
        if (isWavFormat(bytes, chunk)) {
          return sniffed("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave");
        }
      }
      return null;
    case "AVI ": {
      const first = all.next();
      const isHeaderList =
        !first.done && first.value.id === "LIST" && hasAscii(bytes, first.value.data, "hdrl");
      return isHeaderList ? sniffed("video/x-msvideo", "video/avi", "video/msvideo") : null;
    }
    default:
      return null;
  }
}

/** An AIFF/AIFC file: a `FORM` container holding a `COMM` chunk with channels. */
function sniffAiff(bytes: Uint8Array): SniffedType | null {
  const form = container(bytes, "FORM", false);
  if (form === null || (form.form !== "AIFF" && form.form !== "AIFC")) return null;
  for (const chunk of chunks(bytes, 12, form.end, false)) {
    if (chunk.id === "COMM") {
      const channels = u16(bytes, chunk.data) ?? 0;
      return chunk.size >= 18 && channels !== 0 ? sniffed("audio/aiff", "audio/x-aiff") : null;
    }
  }
  return null;
}

/** The chunked-container checks, in the order the sniffer tries them. */
export const CHUNKED_SNIFFERS = [sniffRiff, sniffAiff] as const;
