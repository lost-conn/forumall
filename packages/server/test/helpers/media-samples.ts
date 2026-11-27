/**
 * Media samples for the §5.8 `mime` guard (`provider/media-type.ts`): real
 * files of each format the sniffer confirms ({@link SAMPLES}), plus small
 * hand-built headers for dimension and brand tests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ascii = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0));

/** A `width` x `height` PNG header: signature + IHDR (enough for the sniffer and dimensions). */
export function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set(ascii("IHDR"), 12);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return bytes;
}

/** A real, decodable 1x1 transparent PNG. */
export const onePixelPng = (): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );

/**
 * An ISO-BMFF file: an `ftyp` box of `major` and `compatible` brands, then an
 * empty `free` box (the sniffer needs a well-formed box after `ftyp`).
 */
export function ftyp(major: string, compatible: readonly string[] = []): Uint8Array<ArrayBuffer> {
  const size = 16 + 4 * compatible.length;
  return Uint8Array.from([
    ...[0, 0, 0, size],
    ...ascii("ftyp"),
    ...ascii(major),
    ...[0, 0, 0, 0],
    ...compatible.flatMap(ascii),
    ...[0, 0, 0, 8],
    ...ascii("free"),
  ]);
}

/** A real file from `test/fixtures/media/` (made with ffmpeg / ImageMagick). */
export const fixture = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(join(import.meta.dir, "..", "fixtures", "media", name)));

/**
 * Real files keyed by a short name: the bytes and the `primary` type they
 * sniff as. Each is a complete, decodable file of a few pixels or frames, so
 * the sniffer's structural checks run against what encoders really write.
 */
export const SAMPLES: Readonly<
  Record<string, { bytes: Uint8Array<ArrayBuffer>; primary: string }>
> = {
  png: { bytes: fixture("sample.png"), primary: "image/png" },
  jpeg: { bytes: fixture("sample.jpg"), primary: "image/jpeg" },
  gif: { bytes: fixture("sample.gif"), primary: "image/gif" },
  webp: { bytes: fixture("sample.webp"), primary: "image/webp" },
  bmp: { bytes: fixture("sample.bmp"), primary: "image/bmp" },
  ico: { bytes: fixture("sample.ico"), primary: "image/x-icon" },
  tiff: { bytes: fixture("sample.tif"), primary: "image/tiff" },
  jxl: { bytes: fixture("sample-container.jxl"), primary: "image/jxl" },
  avif: { bytes: fixture("sample.avif"), primary: "image/avif" },
  heic: { bytes: fixture("sample.heic"), primary: "image/heic" },
  mp4: { bytes: fixture("sample.mp4"), primary: "video/mp4" },
  m4a: { bytes: fixture("sample.m4a"), primary: "audio/mp4" },
  mov: { bytes: fixture("sample.mov"), primary: "video/quicktime" },
  "3gp": { bytes: fixture("sample.3gp"), primary: "video/3gpp" },
  webm: { bytes: fixture("sample.webm"), primary: "video/webm" },
  mkv: { bytes: fixture("sample.mkv"), primary: "video/x-matroska" },
  ogg: { bytes: fixture("sample.ogg"), primary: "audio/ogg" },
  opus: { bytes: fixture("sample.opus"), primary: "audio/ogg" },
  wav: { bytes: fixture("sample.wav"), primary: "audio/wav" },
  avi: { bytes: fixture("sample.avi"), primary: "video/x-msvideo" },
  flac: { bytes: fixture("sample.flac"), primary: "audio/flac" },
  aiff: { bytes: fixture("sample.aiff"), primary: "audio/aiff" },
  midi: { bytes: fixture("sample.mid"), primary: "audio/midi" },
  mp3Id3: { bytes: fixture("sample-id3.mp3"), primary: "audio/mpeg" },
  mp3Frames: { bytes: fixture("sample-frames.mp3"), primary: "audio/mpeg" },
  aac: { bytes: fixture("sample.aac"), primary: "audio/aac" },
  mpeg: { bytes: fixture("sample.mpg"), primary: "video/mpeg" },
  ts: { bytes: fixture("sample.m2t"), primary: "video/mp2t" },
};

/** Bytes no format sniffs as: an HTML page with a script. */
export const SCRIPT_BYTES = new TextEncoder().encode('<html><script>alert("x")</script></html>');
