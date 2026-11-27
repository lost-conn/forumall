/**
 * The §5.8 upload `mime` guard (`provider/media-type.ts`), as a unit: the
 * magic-byte sniffer and `determineUploadMime`, plus the multipart header
 * reader that supplies the declared type (`provider/multipart-headers.ts`).
 * The upload route's use of them is covered end to end by
 * `media-target.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  OCTET_STREAM,
  determineUploadMime,
  mediaTypeEssence,
  sniffMediaType,
} from "../src/provider/media-type.ts";
import { multipartPartHeaders } from "../src/provider/multipart-headers.ts";
import { SAMPLES, SCRIPT_BYTES, fixture, ftyp } from "./helpers/media-samples.ts";
import { buildMultipart } from "./helpers/media-upload.ts";

describe("sniffMediaType", () => {
  for (const [name, { bytes, primary }] of Object.entries(SAMPLES)) {
    test(`${name} sniffs as ${primary}`, () => {
      const sniffed = sniffMediaType(bytes);
      expect(sniffed?.primary).toBe(primary);
      expect(sniffed?.types[0]).toBe(primary);
    });
  }

  /** `bytes` as text: every byte that is not printable ASCII (or tab, CR, LF) becomes a space. */
  const textual = (bytes: Uint8Array): Uint8Array =>
    bytes.map((b) => (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b < 0x7f) ? b : 0x20));
  const text = (s: string) => new TextEncoder().encode(s);
  const lorem = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12);

  test("text keeping a real file's ASCII signature and layout sniffs as nothing", () => {
    // The magic numbers that are ASCII survive (GIF89a, RIFF/WEBP, ftyp brands,
    // OggS, ID3, the 0x47 TS sync bytes…); the binary structure does not.
    for (const [name, { bytes }] of Object.entries(SAMPLES)) {
      expect({ name, sniffed: sniffMediaType(textual(bytes)) }).toEqual({ name, sniffed: null });
    }
  });

  test("weak signatures followed by text are not confirmed", () => {
    // `G` at bytes 0 and 188: two transport-stream sync bytes, but text.
    const g = `G${lorem}`.slice(0, 376).split("");
    g[188] = "G";
    const cases: Record<string, Uint8Array> = {
      ts: text(g.join("")),
      tsWholePackets: text(`G${"x".repeat(187)}`.repeat(4)),
      id3: text(`ID3 ${lorem}`),
      // A well-formed empty ID3v2.4 tag, then text where MP3 frames must be.
      id3Header: Uint8Array.from([...text("ID3"), 4, 0, 0, 0, 0, 0, 0, ...text(lorem)]),
      ico: Uint8Array.from([0, 0, 1, 0, 1, 0, ...text(lorem)]),
      jxl: Uint8Array.from([0xff, 0x0a, ...text(lorem)]),
      gif: text(`GIF89a${lorem}`),
      webp: text(`RIFF\x20\x20\x20\x20WEBPVP8 ${lorem}`),
      ftyp: text(`    ftypisom    isomavc1${lorem}`),
      ogg: text(`OggS ${lorem}`),
      flac: text(`fLaC${lorem}`),
      midi: text(`MThd${lorem}`),
      aiff: text(`FORM    AIFFCOMM${lorem}`),
      amr: text(`#!AMR\n${lorem}`),
      bmp: text(`BM${lorem}`),
      // MP3 sync bytes and a valid first frame header, then no second frame.
      mp3: Uint8Array.from([0xff, 0xfb, 0x90, 0x64, ...text(lorem)]),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      expect({ name, sniffed: sniffMediaType(bytes) }).toEqual({ name, sniffed: null });
      expect({ name, mime: determineUploadMime("", bytes) }).toEqual({ name, mime: OCTET_STREAM });
    }
    expect(determineUploadMime("video/mp2t", cases.ts ?? text(""))).toBe(OCTET_STREAM);
    expect(determineUploadMime("audio/mpeg", cases.id3Header ?? text(""))).toBe(OCTET_STREAM);
    expect(determineUploadMime("image/x-icon", cases.ico ?? text(""))).toBe(OCTET_STREAM);
    expect(determineUploadMime("image/jxl", cases.jxl ?? text(""))).toBe(OCTET_STREAM);
  });

  test("formats with too little structure to check are never confirmed", () => {
    // A real bare JPEG XL codestream (only its container form is confirmed).
    const codestream = fixture("sample-codestream.jxl");
    expect(sniffMediaType(codestream)).toBeNull();
    expect(determineUploadMime("image/jxl", codestream)).toBe(OCTET_STREAM);
  });

  test("a truncated real file is not confirmed", () => {
    for (const name of ["png", "gif", "ico", "webp", "wav", "mp4", "webm", "ogg", "flac", "ts"]) {
      const bytes = SAMPLES[name]?.bytes ?? new Uint8Array();
      const cut = bytes.subarray(0, name === "ts" ? 200 : Math.min(30, bytes.length - 1));
      expect({ name, sniffed: sniffMediaType(cut) }).toEqual({ name, sniffed: null });
    }
  });

  test("text, HTML, empty and truncated input sniff as nothing", () => {
    for (const bytes of [
      SCRIPT_BYTES,
      new Uint8Array(),
      new TextEncoder().encode("hello"),
      new Uint8Array([0x89, 0x50, 0x4e]), // a cut-off PNG signature
      new Uint8Array([0xff, 0xd8]), // a cut-off JPEG SOI
      new TextEncoder().encode("RIFF\0\0\0\0TEXT"), // RIFF of an unknown form
      new Uint8Array([0xff, 0xff, 0xff, 0xff]), // sync bits with reserved fields
      new TextEncoder().encode("BM hello, not a bitmap at all......"),
    ]) {
      expect(sniffMediaType(bytes)).toBeNull();
    }
  });

  test("ISO-BMFF: image brands confirm image types only; movie files confirm audio and video", () => {
    expect(sniffMediaType(ftyp("mif1", ["avif"]))?.types).toEqual(["image/avif"]);
    const mp4 = sniffMediaType(ftyp("isom", ["mp41"]))?.types ?? [];
    expect(mp4).toContain("audio/mp4");
    expect(mp4).toContain("video/quicktime");
    expect(mp4).not.toContain("image/avif");
    // A box too short to hold its brands is no ISO-BMFF file.
    const short = ftyp("isom");
    short[3] = 8;
    expect(sniffMediaType(short)).toBeNull();
  });
});

describe("determineUploadMime (§5.8)", () => {
  const png = SAMPLES.png?.bytes ?? new Uint8Array();
  const mp4 = SAMPLES.mp4?.bytes ?? new Uint8Array();

  test("an inline type the bytes confirm is recorded, aliases included", () => {
    expect(determineUploadMime("image/png", png)).toBe("image/png");
    expect(determineUploadMime("IMAGE/PNG; charset=binary", png)).toBe("image/png");
    expect(determineUploadMime("video/mp4", mp4)).toBe("video/mp4");
    expect(determineUploadMime("audio/mp4", mp4)).toBe("audio/mp4");
    expect(determineUploadMime("audio/x-wav", SAMPLES.wav?.bytes ?? png)).toBe("audio/x-wav");
  });

  test("an inline type the bytes do not confirm is application/octet-stream", () => {
    expect(determineUploadMime("image/png", SCRIPT_BYTES)).toBe(OCTET_STREAM);
    // Bytes of another format do not confirm the declared one.
    expect(determineUploadMime("image/jpeg", png)).toBe(OCTET_STREAM);
    expect(determineUploadMime("video/mp4", png)).toBe(OCTET_STREAM);
    expect(determineUploadMime("audio/mpeg", SCRIPT_BYTES)).toBe(OCTET_STREAM);
    // An inline type the sniffer does not know is never confirmed.
    expect(determineUploadMime("image/x-unknown", png)).toBe(OCTET_STREAM);
  });

  test("a type that is not inline is recorded as declared, whatever the bytes", () => {
    expect(determineUploadMime("text/plain", SCRIPT_BYTES)).toBe("text/plain");
    expect(determineUploadMime("text/html", SCRIPT_BYTES)).toBe("text/html");
    expect(determineUploadMime("image/svg+xml", SCRIPT_BYTES)).toBe("image/svg+xml");
    expect(determineUploadMime("application/pdf", png)).toBe("application/pdf");
    expect(determineUploadMime("Application/Octet-Stream", png)).toBe(OCTET_STREAM);
  });

  test("no or an unparsable declared type records what the bytes are, else octet-stream", () => {
    expect(determineUploadMime("", png)).toBe("image/png");
    expect(determineUploadMime("not a type", mp4)).toBe("video/mp4");
    expect(determineUploadMime("", SCRIPT_BYTES)).toBe(OCTET_STREAM);
  });

  test("mediaTypeEssence lowercases, strips parameters and refuses non-types", () => {
    expect(mediaTypeEssence(" Text/Plain ; charset=utf-8")).toBe("text/plain");
    expect(mediaTypeEssence("")).toBeNull();
    expect(mediaTypeEssence("text")).toBeNull();
    expect(mediaTypeEssence("a/b/c")).toBeNull();
  });
});

describe("multipartPartHeaders", () => {
  test("reads each part's name and declared Content-Type, not a filename guess", () => {
    const { body, contentType } = buildMultipart(
      SCRIPT_BYTES,
      "clip.mp4",
      "image/png",
      [["target", "other.test"]],
      [
        { name: "thumbnail", filename: "p.png", mime: "", bytes: new Uint8Array([1, 2]) },
        { name: "extra", filename: 'a";name="file', mime: "text/plain", bytes: SCRIPT_BYTES },
      ],
    );
    expect(multipartPartHeaders(body, contentType)).toEqual([
      { name: "target", contentType: null },
      { name: "file", contentType: "image/png" },
      { name: "thumbnail", contentType: null },
      { name: "extra", contentType: "text/plain" },
    ]);
  });

  test("a quoted boundary works; a body that is not multipart has no parts", () => {
    const { body, contentType } = buildMultipart(SCRIPT_BYTES, "a.txt", "Text/Plain");
    const quoted = contentType.replace(/boundary=(.*)$/, 'boundary="$1"');
    expect(multipartPartHeaders(body, quoted)).toEqual([
      { name: "file", contentType: "Text/Plain" },
    ]);
    expect(multipartPartHeaders(body, "application/json")).toEqual([]);
    expect(multipartPartHeaders(new Uint8Array(), contentType)).toEqual([]);
  });

  test("delimiters are exactly RFC 2046's: `--boundary`, optional `--`, padding, CRLF", () => {
    const B = "XYZ";
    const type = `multipart/form-data; boundary=${B}`;
    const part = (name: string, value: string, mime?: string) =>
      `Content-Disposition: form-data; name="${name}"\r\n${mime ? `Content-Type: ${mime}\r\n` : ""}\r\n${value}`;
    const read = (body: string) =>
      multipartPartHeaders(new TextEncoder().encode(body), type).map((p) => p.name);
    // `--boundary` followed by other text, inside a body, is body text.
    const fake = `1\r\n--${B}X\r\n${part("file", "fake", "text/html")}`;
    expect(
      read(`--${B}\r\n${part("a", fake)}\r\n--${B}\r\n${part("b", "2")}\r\n--${B}--\r\n`),
    ).toEqual(["a", "b"]);
    // So is `--boundary--` followed by text on the same line.
    const dashText = `1\r\n--${B}--junk`;
    expect(
      read(`--${B}\r\n${part("a", dashText)}\r\n--${B}\r\n${part("b", "2")}\r\n--${B}--`),
    ).toEqual(["a", "b"]);
    // Transport padding before the CRLF is allowed; a preamble is skipped.
    expect(
      read(`pre\r\n--${B} \t\r\n${part("a", "1")}\r\n--${B}  \r\n${part("b", "2")}\r\n--${B}--  `),
    ).toEqual(["a", "b"]);
    // Nothing after the close delimiter is a part (the epilogue).
    expect(
      read(`--${B}\r\n${part("a", "1")}\r\n--${B}--\r\n--${B}\r\n${part("z", "9")}\r\n--${B}--`),
    ).toEqual(["a"]);
  });
});
