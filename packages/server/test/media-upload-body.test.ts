/**
 * The raw body of `POST /api/media` (spec §5.8): which parts it holds, and
 * how large it may be before anything buffers it.
 *
 *  - The declared part types are read by a delimiter-exact multipart parser
 *    (`provider/multipart-headers.ts`, RFC 2046 §5.1.1), so a part body
 *    cannot smuggle in a fake `file` part; a body that parser and Bun's
 *    `FormData` read as different parts is refused (`400`).
 *  - The upload body limit applies before the §4.5 signature middleware
 *    buffers the body (`http/body-limits.ts`): by `Content-Length`, and by
 *    counting a chunked body as it streams. `Bun.serve` refuses any body over
 *    the largest a route accepts (`maxRequestBodySize`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentSchema } from "@forumall/shared";

import { maxRequestBodyBytes, maxUploadBodyBytes } from "../src/http/body-limits.ts";
import { SAMPLES, SCRIPT_BYTES } from "./helpers/media-samples.ts";
import {
  buildMultipart,
  postSignedUpload,
  uploadHeaders,
  uploadMedia,
} from "./helpers/media-upload.ts";
import { type Booted, boot as bootIn, registerUserWithKey } from "./helpers/provider-harness.ts";

let tmp: string;
const booted: Booted[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-media-body-"));
});
afterAll(() => {
  for (const b of booted) b.server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

function boot(name: string, env: Record<string, string> = {}): Booted {
  const b = bootIn(tmp, name, env);
  booted.push(b);
  return b;
}

const enc = new TextEncoder();
const boundaryOf = (contentType: string) => contentType.slice(contentType.indexOf("=") + 1);
const concat = (...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

describe("multipart parts (§5.8 declared type)", () => {
  test("a fake `file` part inside another part's body is not read as a part", async () => {
    const b = boot("fake-part");
    const alice = await registerUserWithKey(b, "alice");
    const { contentType } = buildMultipart(SCRIPT_BYTES, "a.txt", "text/plain");
    const boundary = boundaryOf(contentType);
    // `--boundary` followed by anything but `--`, padding or CRLF is body text.
    const fakeHeaders = [
      'Content-Disposition: form-data; name="file"; filename="x.html"',
      "Content-Type: text/html",
    ].join("\r\n");
    const smuggled = `note\r\n--${boundary}X\r\n${fakeHeaders}\r\n\r\n<script>`;
    const res = await uploadMedia(b.app, alice, SCRIPT_BYTES, "a.txt", "text/plain", [
      ["note", smuggled],
    ]);
    expect(res.status).toBe(201);
    expect(AttachmentSchema.parse(await res.json()).mime).toBe("text/plain");
  });

  test("a body the two parsers read as different parts is 400", async () => {
    const b = boot("parser-disagree");
    const alice = await registerUserWithKey(b, "alice");
    const { body, contentType } = buildMultipart(
      SAMPLES.png?.bytes ?? SCRIPT_BYTES,
      "a.png",
      "image/png",
    );
    const boundary = boundaryOf(contentType);
    // A part after the close delimiter: epilogue to RFC 2046, a part to Bun.
    // Nothing else about it is refused (an unknown text part is ignored).
    const epiloguePart = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nzz\r\n--${boundary}--\r\n`,
    );
    const res = await postSignedUpload(b.app, alice, concat(body, epiloguePart), contentType);
    expect(res.status).toBe(400);
    const count = b.db.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media").get();
    expect(count?.n).toBe(0);
  });
});

describe("upload body limit before buffering", () => {
  const MAX_UPLOAD_BYTES = 1024;

  test("a declared Content-Length over the limit is 413 before the signature is checked", async () => {
    const b = boot("cl-limit", { MAX_UPLOAD_BYTES: String(MAX_UPLOAD_BYTES) });
    const body = new Uint8Array(maxUploadBodyBytes(b.config) + 1);
    // Unsigned: the signature middleware would answer 401 if it ran first.
    const res = await b.app.request("/api/media", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body,
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toStartWith("application/problem+json");
  });

  test("a chunked body is refused once it passes the limit, without reading the rest", async () => {
    const b = boot("chunked-limit", { MAX_UPLOAD_BYTES: String(MAX_UPLOAD_BYTES) });
    const alice = await registerUserWithKey(b, "alice");
    const chunk = new Uint8Array(16 * 1024);
    const totalChunks = 200;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === totalChunks) return controller.close();
        pulled++;
        controller.enqueue(chunk);
      },
    });
    // Well-formed signature headers (for other bytes): the middleware would
    // buffer the whole stream at §4.5 step 5 if the limit did not run first.
    const res = await b.app.request("/api/media", {
      method: "POST",
      headers: {
        ...uploadHeaders(alice, new Uint8Array()),
        "content-type": "multipart/form-data; boundary=x",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    const limitChunks = Math.ceil(maxUploadBodyBytes(b.config) / chunk.length);
    expect(pulled).toBeLessThanOrEqual(limitChunks + 2);
  });

  test("Bun.serve refuses a body over the largest any route accepts", async () => {
    const b = boot("serve-limit", { MAX_UPLOAD_BYTES: String(MAX_UPLOAD_BYTES) });
    const limit = maxRequestBodyBytes(b.config);
    expect(b.app.__maxRequestBodySize).toBe(limit);
    // At least the upload body and the WebSocket frame limit (a REST command
    // must fit what the same WS command may carry).
    expect(limit).toBe(Math.max(maxUploadBodyBytes(b.config), b.config.wsMaxFrameBytes));
    const origin = `http://${b.server.hostname}:${b.server.port}`;
    const res = await fetch(`${origin}/api/groups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(limit + 1),
    });
    expect(res.status).toBe(413);
  });
});
