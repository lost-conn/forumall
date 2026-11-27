/**
 * Minimal byte samples of media formats, for the §5.8 `mime` guard
 * (`provider/media-type.ts`): each holds just the magic bytes or container
 * header the sniffer reads, not a decodable file (except {@link onePixelPng}).
 */

const ascii = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0));

/** `head` followed by zero padding up to `length` bytes. */
function padded(head: readonly number[], length = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(length, head.length));
  bytes.set(head, 0);
  return bytes;
}

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

/** An ISO-BMFF file starting with an `ftyp` box of `major` and `compatible` brands. */
export function ftyp(major: string, compatible: readonly string[] = []): Uint8Array<ArrayBuffer> {
  const size = 16 + 4 * compatible.length;
  const head = [
    ...[0, 0, 0, size],
    ...ascii("ftyp"),
    ...ascii(major),
    ...[0, 0, 0, 0],
    ...compatible.flatMap(ascii),
  ];
  return padded(head, size + 16);
}

/** A RIFF container of form type `form` (`WEBP`, `WAVE`, `AVI `). */
const riff = (form: string): Uint8Array<ArrayBuffer> =>
  padded([...ascii("RIFF"), 0, 0, 0, 0, ...ascii(form)]);

/** Samples keyed by a short name: the bytes and the `primary` type they sniff as. */
export const SAMPLES: Readonly<
  Record<string, { bytes: Uint8Array<ArrayBuffer>; primary: string }>
> = {
  png: { bytes: pngHeader(2, 3), primary: "image/png" },
  jpeg: { bytes: padded([0xff, 0xd8, 0xff, 0xe0]), primary: "image/jpeg" },
  gif: { bytes: padded(ascii("GIF89a")), primary: "image/gif" },
  webp: { bytes: riff("WEBP"), primary: "image/webp" },
  bmp: { bytes: padded([...ascii("BM"), 0x3a, 0, 0, 0, 0, 0, 0, 0]), primary: "image/bmp" },
  ico: { bytes: padded([0, 0, 1, 0, 1, 0]), primary: "image/x-icon" },
  tiff: { bytes: padded([0x49, 0x49, 0x2a, 0x00]), primary: "image/tiff" },
  jxl: { bytes: padded([0xff, 0x0a]), primary: "image/jxl" },
  avif: { bytes: ftyp("avif", ["mif1", "miaf"]), primary: "image/avif" },
  heic: { bytes: ftyp("heic", ["mif1"]), primary: "image/heic" },
  mp4: { bytes: ftyp("isom", ["isom", "mp41"]), primary: "video/mp4" },
  m4a: { bytes: ftyp("M4A ", ["M4A ", "mp42"]), primary: "audio/mp4" },
  mov: { bytes: ftyp("qt  ", ["qt  "]), primary: "video/quicktime" },
  "3gp": { bytes: ftyp("3gp4", ["isom"]), primary: "video/3gpp" },
  webm: {
    bytes: padded([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...ascii("webm")]),
    primary: "video/webm",
  },
  mkv: {
    bytes: padded([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88, ...ascii("matroska")]),
    primary: "video/x-matroska",
  },
  ogg: { bytes: padded(ascii("OggS")), primary: "audio/ogg" },
  wav: { bytes: riff("WAVE"), primary: "audio/wav" },
  avi: { bytes: riff("AVI "), primary: "video/x-msvideo" },
  flac: { bytes: padded(ascii("fLaC")), primary: "audio/flac" },
  aiff: { bytes: padded([...ascii("FORM"), 0, 0, 0, 0, ...ascii("AIFF")]), primary: "audio/aiff" },
  midi: { bytes: padded(ascii("MThd")), primary: "audio/midi" },
  amr: { bytes: padded(ascii("#!AMR\n")), primary: "audio/amr" },
  mp3Id3: { bytes: padded([...ascii("ID3"), 4, 0, 0, 0, 0, 0, 0]), primary: "audio/mpeg" },
  // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz.
  mp3Frame: { bytes: padded([0xff, 0xfb, 0x90, 0x64]), primary: "audio/mpeg" },
  // ADTS AAC (MPEG-4, no CRC).
  aac: { bytes: padded([0xff, 0xf1, 0x50, 0x80]), primary: "audio/aac" },
  mpeg: { bytes: padded([0x00, 0x00, 0x01, 0xba]), primary: "video/mpeg" },
  ts: {
    bytes: (() => {
      const b = new Uint8Array(376);
      b[0] = 0x47;
      b[188] = 0x47;
      return b;
    })(),
    primary: "video/mp2t",
  },
};

/** Bytes no format sniffs as: an HTML page with a script. */
export const SCRIPT_BYTES = new TextEncoder().encode('<html><script>alert("x")</script></html>');
