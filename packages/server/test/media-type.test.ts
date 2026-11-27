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
import { SAMPLES, SCRIPT_BYTES, ftyp } from "./helpers/media-samples.ts";
import { buildMultipart } from "./helpers/media-upload.ts";

describe("sniffMediaType", () => {
  for (const [name, { bytes, primary }] of Object.entries(SAMPLES)) {
    test(`${name} sniffs as ${primary}`, () => {
      const sniffed = sniffMediaType(bytes);
      expect(sniffed?.primary).toBe(primary);
      expect(sniffed?.types[0]).toBe(primary);
    });
  }

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
});
