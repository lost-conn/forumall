/**
 * Audio and video formats identified by a structured header: Matroska/WebM
 * (EBML), Ogg, FLAC and Standard MIDI. Each check parses the header the format
 * starts with — its element or page structure, the codec it names — rather
 * than trusting the magic bytes alone.
 */
import { type SniffedType, asciiAt, hasAscii, hasBytes, sniffed, u16, u24, u32 } from "./common.ts";

/** An EBML variable-length integer: its value (marker bit kept for IDs) and length. */
interface Vint {
  readonly value: number;
  readonly length: number;
  /** Whether every value bit is set (an "unknown" size, RFC 8794 §6.2). */
  readonly unknown: boolean;
}

/**
 * The EBML variable-length integer at `offset` (RFC 8794 §4), or `null` when
 * it is invalid (a zero first byte) or runs past the end. With `keepMarker`
 * the length-marker bit stays in the value, as element IDs are written.
 */
function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): Vint | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23; // leading zeros within the byte, plus one
  if (offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const b = bytes[offset + i] ?? 0;
    value = value * 0x100 + b;
    allOnes &&= b === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const EBML_ID = [0x1a, 0x45, 0xdf, 0xa3];
const EBML_DOCTYPE_ID = 0x4282;
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const EBML_TYPES = ["video/webm", "audio/webm", "video/x-matroska", "audio/x-matroska"];

/**
 * Matroska or WebM: an EBML header of known size whose child elements are
 * well formed and include a `DocType` of `webm` or `matroska`, followed by
 * the `Segment` element (RFC 8794 §8, RFC 9559).
 */
function sniffEbml(bytes: Uint8Array): SniffedType | null {
  if (!hasBytes(bytes, 0, EBML_ID)) return null;
  const headerSize = readVint(bytes, 4, false);
  if (headerSize === null || headerSize.unknown) return null;
  const start = 4 + headerSize.length;
  const end = start + headerSize.value;
  if (!hasBytes(bytes, end, SEGMENT_ID)) return null;
  let docType: string | null = null;
  for (let at = start; at < end; ) {
    const id = readVint(bytes, at, true);
    const size = id && readVint(bytes, at + id.length, false);
    if (id === null || size === null || size.unknown) return null;
    const data = at + id.length + size.length;
    if (data + size.value > end) return null;
    if (id.value === EBML_DOCTYPE_ID) {
      // A string element may be padded with trailing NULs (RFC 8794 §7.4).
      docType = asciiAt(bytes, data, size.value)?.replace(/\0+$/, "") ?? null;
    }
    at = data + size.value;
  }
  if (docType !== "webm" && docType !== "matroska") return null;
  const primary = docType === "webm" ? "video/webm" : "video/x-matroska";
  return sniffed(primary, ...EBML_TYPES.filter((t) => t !== primary));
}

/** The codec identification packets an Ogg stream's first page may start with. */
const OGG_AUDIO = sniffed("audio/ogg", "video/ogg");
const OGG_CODECS: readonly { readonly magic: readonly number[]; readonly type: SniffedType }[] = [
  { magic: [0x01, ...Buffer.from("vorbis")], type: OGG_AUDIO },
  { magic: [...Buffer.from("OpusHead")], type: sniffed("audio/ogg", "audio/opus", "video/ogg") },
  { magic: [0x7f, ...Buffer.from("FLAC")], type: OGG_AUDIO },
  { magic: [...Buffer.from("Speex   ")], type: OGG_AUDIO },
  { magic: [0x80, ...Buffer.from("theora")], type: sniffed("video/ogg", "audio/ogg") },
];

/**
 * Ogg: a first page (RFC 3533 §6) of stream structure version 0 marked
 * beginning-of-stream, whose segment table and payload fit the file, and whose
 * first packet identifies a known codec.
 */
function sniffOgg(bytes: Uint8Array): SniffedType | null {
  if (!hasAscii(bytes, 0, "OggS") || bytes[4] !== 0) return null;
  const headerType = bytes[5] ?? 0;
  // Only the continued / BOS / EOS flags exist, and a first page is BOS, not continued.
  if ((headerType & 0xf8) !== 0 || (headerType & 0x03) !== 0x02) return null;
  const segments = bytes[26];
  if (segments === undefined || segments === 0 || 27 + segments > bytes.length) return null;
  let payload = 0;
  for (let i = 0; i < segments; i++) payload += bytes[27 + i] ?? 0;
  const packet = 27 + segments;
  if (packet + payload > bytes.length) return null;
  const codec = OGG_CODECS.find(
    (c) => c.magic.length <= payload && hasBytes(bytes, packet, c.magic),
  );
  return codec?.type ?? null;
}

/** FLAC: `fLaC`, then the mandatory STREAMINFO metadata block (type 0, 34 bytes) in full. */
function sniffFlac(bytes: Uint8Array): SniffedType | null {
  if (!hasAscii(bytes, 0, "fLaC") || ((bytes[4] ?? 0xff) & 0x7f) !== 0) return null;
  if (u24(bytes, 5) !== 34 || bytes.length < 8 + 34) return null;
  return sniffed("audio/flac", "audio/x-flac");
}

/**
 * Standard MIDI: an `MThd` chunk of length 6 (format 0–2, at least one track),
 * then an `MTrk` chunk whose length fits the file.
 */
function sniffMidi(bytes: Uint8Array): SniffedType | null {
  if (!hasAscii(bytes, 0, "MThd") || u32(bytes, 4) !== 6) return null;
  const format = u16(bytes, 8);
  const tracks = u16(bytes, 10);
  if (format === null || format > 2 || tracks === null || tracks === 0) return null;
  const trackLength = u32(bytes, 18);
  if (!hasAscii(bytes, 14, "MTrk") || trackLength === null || 22 + trackLength > bytes.length) {
    return null;
  }
  return sniffed("audio/midi", "audio/x-midi", "audio/mid");
}

/** The structured-header stream checks, in the order the sniffer tries them. */
export const STREAM_SNIFFERS = [sniffEbml, sniffOgg, sniffFlac, sniffMidi] as const;
