/**
 * Serving attachments (spec §5.8 "Serving attachments"): the per-type
 * disposition, sandbox CSP and `nosniff` headers; private (never public)
 * caching with a strong `ETag` and `If-None-Match` → `304`; and the capability
 * URL properties (https, ≥128 bits of CSPRNG entropy per id, unlisted,
 * fetchable unsigned). Real uploads through `POST /api/media` on a real server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Attachment, AttachmentSchema } from "@forumall/shared";

import { contentDisposition, rendersInline } from "../src/http/media-headers.ts";
import { mintMediaId } from "../src/provider/media.ts";
import { SAMPLES } from "./helpers/media-samples.ts";
import { uploadMedia } from "./helpers/media-upload.ts";
import {
  type Booted,
  DOMAIN,
  type Signer,
  boot,
  registerUserWithKey,
  signedReq,
} from "./helpers/provider-harness.ts";

let tmp: string;
let b: Booted;
let alice: Signer;
const target = {
  request: (path: string, init: RequestInit) => fetch(`${base()}${path}`, init),
};

function base(): string {
  return `http://${b.server.hostname}:${b.server.port}`;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-media-serving-"));
  b = boot(tmp, "p");
  alice = await registerUserWithKey(b, "alice");
});
afterAll(() => {
  b.server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

async function upload(bytes: Uint8Array, filename: string, mime: string): Promise<Attachment> {
  const res = await uploadMedia(target, alice, bytes, filename, mime);
  expect(res.status).toBe(201);
  return AttachmentSchema.parse(await res.json());
}

/** The served path of a hosted attachment `url` (`https://DOMAIN/api/media/…`). */
function pathOf(att: Attachment): string {
  return new URL(att.url).pathname;
}

const PRIVATE_CACHE = "private, max-age=31536000, immutable";

describe("serving headers per media type (§5.8)", () => {
  // [mime, filename, served inline?, sample whose bytes confirm an inline type]
  const matrix: readonly (readonly [string, string, boolean, string?])[] = [
    ["image/png", "pic.png", true, "png"],
    ["image/jpeg", "photo.jpg", true, "jpeg"],
    ["image/svg+xml", "logo.svg", false],
    ["video/mp4", "clip.mp4", true, "mp4"],
    ["audio/mpeg", "song.mp3", true, "mp3Id3"],
    ["text/plain", "notes.txt", false],
    ["text/html", "page.html", false],
    ["application/pdf", "doc.pdf", false],
    ["application/octet-stream", "blob.bin", false],
  ];

  for (const [mime, filename, inline, sample] of matrix) {
    test(`${mime}: ${inline ? "inline" : "Content-Disposition: attachment"}, sandbox, nosniff, private cache`, async () => {
      // An inline type is stored only for bytes that confirm it (§5.8); the
      // other types carry a script, which they are served safely with.
      const bytes =
        (sample !== undefined ? SAMPLES[sample]?.bytes : undefined) ??
        new TextEncoder().encode(`<script>alert("${mime}")</script>`);
      const att = await upload(bytes, filename, mime);
      expect(att.mime).toBe(mime);

      // Fetched with no signature, cookie or other credential.
      const res = await fetch(`${base()}${pathOf(att)}`);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
      expect(res.headers.get("content-type")).toBe(mime);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(res.headers.get("content-disposition")).toBe(
        `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      );
      expect(res.headers.get("cache-control")).toBe(PRIVATE_CACHE);
      expect(res.headers.get("etag")).toBe(`"${att.hash}"`);
    });
  }

  test("never publicly cacheable: no `public`, no shared-cache directive", async () => {
    const att = await upload(SAMPLES.png?.bytes ?? new Uint8Array(), "a.png", "image/png");
    const cc = (await fetch(`${base()}${pathOf(att)}`)).headers.get("cache-control") ?? "";
    const directives = cc.split(",").map((d) => d.trim().split("=")[0]);
    expect(directives).toContain("private");
    expect(directives).not.toContain("public");
    expect(directives).not.toContain("s-maxage");
  });

  test("a non-ASCII filename is sent with an RFC 6266/8187 `filename*`", async () => {
    const att = await upload(new Uint8Array([7]), "résumé 100%.pdf", "application/pdf");
    expect(att.filename).toBe("résumé 100%.pdf");
    const res = await fetch(`${base()}${pathOf(att)}`);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="r_sum_ 100_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20100%25.pdf`,
    );
  });

  test("HEAD carries the same headers and no body", async () => {
    const att = await upload(new TextEncoder().encode("hello"), "a.txt", "text/plain");
    const res = await fetch(`${base()}${pathOf(att)}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="a.txt"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).toBe(`"${att.hash}"`);
  });
});

describe("disposition rules (unit)", () => {
  test("only image/*, video/* and audio/* render inline, never SVG; case-insensitive", () => {
    for (const m of ["image/png", "IMAGE/PNG", "video/webm", "audio/ogg", "image/avif"]) {
      expect(rendersInline(m)).toBe(true);
    }
    for (const m of [
      "image/svg+xml",
      "Image/SVG+XML",
      "text/html",
      "application/xhtml+xml",
      "application/pdf",
      "application/octet-stream",
      "imagex/png",
      "",
    ]) {
      expect(rendersInline(m)).toBe(false);
    }
  });

  test("Content-Disposition values", () => {
    expect(contentDisposition("attachment", null)).toBe("attachment");
    expect(contentDisposition("attachment", "")).toBe("attachment");
    expect(contentDisposition("inline", "a b.png")).toBe('inline; filename="a b.png"');
    // Quotes, backslashes and controls never reach the quoted-string.
    expect(contentDisposition("attachment", 'x"y\\z\r\n.txt')).toBe(
      `attachment; filename="x_y_z__.txt"; filename*=UTF-8''x%22y%5Cz%0D%0A.txt`,
    );
    // RFC 8187 attr-chars stay as they are; others ('()* included) are encoded.
    expect(contentDisposition("attachment", "日本 (1)*.txt")).toBe(
      `attachment; filename="__ (1)*.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%20%281%29%2A.txt`,
    );
    // A lone surrogate is encoded as U+FFFD rather than throwing.
    expect(contentDisposition("attachment", "a\uD800.txt")).toBe(
      `attachment; filename="a_.txt"; filename*=UTF-8''a%EF%BF%BD.txt`,
    );
  });
});

describe("ETag revalidation (§5.8 caching)", () => {
  let att: Attachment;
  beforeAll(async () => {
    att = await upload(new TextEncoder().encode("cache me"), "c.txt", "text/plain");
  });

  const get = (headers: Record<string, string>, method = "GET") =>
    fetch(`${base()}${pathOf(att)}`, { method, headers });

  test("a matching If-None-Match → 304 with the validators, no body", async () => {
    const etag = `"${att.hash}"`;
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const res = await get({ "if-none-match": inm });
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe(PRIVATE_CACHE);
    }
    expect((await get({ "if-none-match": etag }, "HEAD")).status).toBe(304);
  });

  test("a non-matching or malformed If-None-Match → 200", async () => {
    for (const inm of ['"sha-256:nope"', "W/", "sha-256:unquoted", `"${att.hash}`]) {
      const res = await get({ "if-none-match": inm });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("cache me");
    }
  });

  test("a row whose blob is gone is 404 whether or not the request is conditional", async () => {
    const gone = await upload(new TextEncoder().encode("soon gone"), "g.txt", "text/plain");
    const id = pathOf(gone).split("/").at(-1) ?? "";
    await rm(join(b.config.mediaDir, id));
    const etag = `"${gone.hash}"`;
    const conditions: Record<string, string>[] = [
      {},
      { "if-none-match": etag },
      { "if-none-match": "*" },
    ];
    for (const headers of conditions) {
      for (const method of ["GET", "HEAD"]) {
        const res = await fetch(`${base()}${pathOf(gone)}`, { method, headers });
        expect(res.status).toBe(404);
      }
    }
  });

  test("an unknown id is 404 even with If-None-Match: *", async () => {
    const res = await fetch(`${base()}/api/media/${mintMediaId()}`, {
      headers: { "if-none-match": "*" },
    });
    expect(res.status).toBe(404);
  });
});

describe("capability URLs (§5.8)", () => {
  /** The random bytes of an `att_<base64url>` id. */
  function idBytes(id: string): Buffer {
    expect(id).toMatch(/^att_[A-Za-z0-9_-]+$/);
    return Buffer.from(id.slice("att_".length), "base64url");
  }

  test("each id carries 128 random bits; identical uploads get unrelated ids", async () => {
    const bytes = new TextEncoder().encode("same bytes");
    const a = await upload(bytes, "x.txt", "text/plain");
    const c = await upload(bytes, "x.txt", "text/plain");
    for (const att of [a, c]) {
      expect(idBytes(att.id).length).toBeGreaterThanOrEqual(16);
      expect(att.url).toBe(`https://${DOMAIN}/api/media/${att.id}`);
    }
    // Same content, same uploader: nothing about the id derives from either.
    expect(a.hash).toBe(c.hash);
    expect(a.id).not.toBe(c.id);
  });

  test("minted ids are distinct and evenly spread (no fixed bits)", () => {
    const ids = Array.from({ length: 2000 }, () => mintMediaId());
    expect(new Set(ids).size).toBe(ids.length);
    // Every one of the 128 bit positions takes both values across the sample;
    // a counter, timestamp or truncated source would pin some of them.
    const ones = new Array<number>(128).fill(0);
    for (const id of ids) {
      const raw = idBytes(id);
      expect(raw.length).toBe(16);
      for (let bit = 0; bit < 128; bit++) {
        if ((raw[bit >> 3] ?? 0) & (0x80 >> (bit & 7))) ones[bit] = (ones[bit] ?? 0) + 1;
      }
    }
    for (const n of ones) {
      expect(n).toBeGreaterThan(800);
      expect(n).toBeLessThan(1200);
    }
  });

  test("attachment URLs are unlisted: no index at /api/media or /api/media/", async () => {
    await upload(new Uint8Array([1]), "listed.txt", "text/plain");
    for (const path of ["/api/media", "/api/media/"]) {
      for (const res of [await fetch(`${base()}${path}`), await signedReq(b, alice, "GET", path)]) {
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("att_");
      }
    }
  });
});
