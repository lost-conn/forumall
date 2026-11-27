/**
 * `/api/media` router — media upload + serve (spec §5.8).
 *
 *  - `POST /api/media` (signed, §4.4): single-step `multipart/form-data` upload.
 *    Stores the blob via the injected {@link StorageBackend} and returns the
 *    hosted `Attachment`. → 201. Enforces `config.maxUploadBytes` on each file
 *    part → 413. Reading the form (`provider/media-upload.ts`): the optional
 *    `target` part (recorded; a remote one makes a remote upload), the
 *    optional `thumbnail` part (stored as its own upload, returned as
 *    `thumbnail`), the guarded `mime` (`provider/media-type.ts`), and
 *    `width` / `height` from the image header when it can be read, otherwise,
 *    like `durationMs`, from optional form parts of the same names beside
 *    `file`. A malformed part → 400.
 *  - `GET /api/media/:id` (and `HEAD`): serve the stored bytes with the stored
 *    content type and the §5.8 serving headers (`media-headers.ts`:
 *    disposition, sandbox CSP, nosniff, private caching, strong `ETag`).
 *    → 200, `304` for a matching `If-None-Match`, or 404 if unknown or its
 *    blob is gone (conditional or not). There is deliberately no
 *    `GET /api/media` (§5.8: attachment URLs are unlisted).
 *
 * ## Body buffering + the signature middleware
 * `requireSignature` (§4.5 step 5) reads the raw request body via
 * `c.req.arrayBuffer()` to recompute the content-digest. Hono caches the parsed
 * body, so `c.req.parseBody()` / `c.req.formData()` downstream still work — they
 * re-parse the same cached bytes. The digest is verified over the **raw**
 * multipart bytes (exactly what the client signed), before we touch the parts.
 *
 * ## Read authorization
 * `GET /api/media/:id` is intentionally **unauthenticated**: attachment URLs are
 * capability URLs (unguessable `att_<128-bit>` ids) embedded in messages, so any
 * client that legitimately received the message can fetch the blob without
 * re-running the §4.4 signing dance. This keeps `<img src>` and link previews
 * simple. Knowing the id is the capability.
 */
import { Hono } from "hono";

import type { Config } from "../config.ts";
import { readUploadForm, storeUpload } from "../provider/media-upload.ts";
import { getMediaRow, hostedAttachment } from "../provider/media.ts";
import { multipartPartHeaders } from "../provider/multipart-headers.ts";
import { FsStorage, type StorageBackend } from "../provider/storage.ts";
import { ifNoneMatchMatches } from "./conditional.ts";
import { AppError } from "./errors.ts";
import { mediaETag, mediaNotModifiedHeaders, mediaResponseHeaders } from "./media-headers.ts";
import { optionalSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

export interface MediaRouterOptions {
  /**
   * Blob storage backend. Defaults to {@link FsStorage} rooted at
   * `config.mediaDir` (resolved per-request from `c.var.config`). Injectable so
   * tests / a future S3 card can supply their own.
   */
  storage?: StorageBackend;
}

/**
 * Room in a multipart body for everything but the file bytes: part headers,
 * boundaries and the small text parts (`target`, `width`, `height`,
 * `durationMs`). Generous, since it only gates the early `Content-Length`
 * reject; each file part is then held to the exact limit.
 */
const MULTIPART_ENVELOPE_BYTES = 64 * 1024;

/**
 * The largest body an acceptable upload can have: a `file` and a `thumbnail`
 * each at the limit, plus the envelope. Larger is a `413` before parsing.
 */
function maxUploadBodyBytes(config: Config): number {
  return 2 * config.maxUploadBytes + MULTIPART_ENVELOPE_BYTES;
}

export function createMediaRouter(opts: MediaRouterOptions = {}): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  /** Resolve the storage backend (injected, else FS rooted at mediaDir). */
  const storageFor = (mediaDir: string): StorageBackend => opts.storage ?? new FsStorage(mediaDir);

  // -- POST /api/media (§5.8, signed) --------------------------------------
  router.post("/", signed, async (c) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable: middleware sets it

    // Early reject on Content-Length when present: avoids buffering/parsing a
    // body we will reject anyway. The signature middleware has already buffered
    // the raw bytes, but the multipart parse + storage write are still skipped.
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxUploadBodyBytes(config)) {
      throw AppError.payloadTooLarge({
        detail: `upload exceeds the ${config.maxUploadBytes}-byte limit`,
      });
    }

    // Parse the multipart body. The §4.5 middleware already consumed the request
    // stream via `c.req.arrayBuffer()` to verify the content-digest; that result
    // is cached, but the underlying stream is spent, so a direct
    // `c.req.formData()` here would fail to read. Re-wrap the cached raw bytes in
    // a fresh `Request` (preserving the multipart content-type + boundary) and
    // parse that. A non-multipart / fileless body is a 400.
    const rawBody = await c.req.arrayBuffer();
    const contentType = c.req.header("content-type") ?? "";
    const form = await new Request("http://x/", {
      method: "POST",
      headers: { "content-type": contentType },
      body: rawBody,
    })
      .formData()
      .catch(() => {
        throw AppError.badRequest({ detail: "request body must be multipart/form-data" });
      });
    const declared = multipartPartHeaders(new Uint8Array(rawBody), contentType);
    const read = await readUploadForm(form, declared, config);
    if (read.refusal !== undefined) {
      const { status, detail } = read.refusal;
      throw status === 413 ? AppError.payloadTooLarge({ detail }) : AppError.badRequest({ detail });
    }

    const row = await storeUpload(db, storageFor(config.mediaDir), read.upload, actor.actor);
    return c.json(hostedAttachment(db, config, row), 201);
  });

  // -- GET /api/media/:id (serve the blob; unauthenticated, see file header) -
  router.get("/:id", optionalSignature(), async (c) => {
    const { config, db } = c.var;
    const id = c.req.param("id");

    const row = getMediaRow(db, id);
    if (!row) throw AppError.notFound({ detail: "no such media" });

    const storage = storageFor(config.mediaDir);
    // A row whose blob is gone (manual deletion / storage drift) is 404.
    const missingBlob = () => AppError.notFound({ detail: "media blob is missing" });

    // The bytes behind an id never change, so a matching validator needs no
    // read of the blob, only a check that it still exists: a conditional
    // request must get the same answer (404) as an unconditional one would.
    if (ifNoneMatchMatches(c.req.header("if-none-match"), mediaETag(row))) {
      if (!(await storage.has(id))) throw missingBlob();
      return new Response(null, { status: 304, headers: mediaNotModifiedHeaders(row) });
    }

    const bytes = await storage.get(id);
    if (!bytes) throw missingBlob();

    // Copy into a fresh ArrayBuffer-backed view so the body is a plain
    // `BodyInit` (the storage backend may hand back a view over an
    // `ArrayBufferLike`). Bun streams the bytes. `content-length` comes from the
    // stored row (the blob is the same size).
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body, { status: 200, headers: mediaResponseHeaders(row) });
  });

  return router;
}
