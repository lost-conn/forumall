/**
 * `/api/media` router — media upload + serve (spec §5.8).
 *
 *  - `POST /api/media` (signed, §4.4): single-step `multipart/form-data` upload.
 *    Stores the blob via the injected {@link StorageBackend} and returns the
 *    hosted `Attachment`. → 201. Enforces `config.maxUploadBytes` → 413.
 *  - `GET /api/media/:id`: serve the stored bytes with the stored content type.
 *    → 200, or 404 if unknown.
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

import {
  contentHash,
  getMediaRow,
  insertMediaRow,
  mintMediaId,
  parseImageDimensions,
  rowToAttachment,
} from "../provider/media.ts";
import { FsStorage, type StorageBackend } from "../provider/storage.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

export interface MediaRouterOptions {
  /**
   * Blob storage backend. Defaults to {@link FsStorage} rooted at
   * `config.mediaDir` (resolved per-request from `c.var.config`). Injectable so
   * tests / a future S3 card can supply their own.
   */
  storage?: StorageBackend;
}

/** Default `Cache-Control` for served blobs: immutable (content-addressed id). */
const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

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
    if (Number.isFinite(contentLength) && contentLength > config.maxUploadBytes) {
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
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw AppError.badRequest({ detail: "multipart body must include a `file` part" });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // Enforce on the actual byte length too (Content-Length may be absent or a
    // lie; the part is the source of truth).
    if (bytes.byteLength > config.maxUploadBytes) {
      throw AppError.payloadTooLarge({
        detail: `upload exceeds the ${config.maxUploadBytes}-byte limit`,
      });
    }

    const id = mintMediaId();
    // `file.type` is the part's declared content type. Strip any parameters
    // (e.g. the `;charset=utf-8` the multipart parser may append) so the stored
    // `mime` is a bare IANA media type per the `Attachment` schema. Fall back to
    // a generic binary type if the client omitted one.
    const rawMime = (file.type ?? "").split(";")[0]?.trim() ?? "";
    const mime = rawMime.length > 0 ? rawMime : "application/octet-stream";
    const hash = contentHash(bytes);
    const dims = parseImageDimensions(bytes);
    const filename = typeof file.name === "string" && file.name.length > 0 ? file.name : undefined;

    await storageFor(config.mediaDir).put(id, bytes, mime);

    const row = insertMediaRow(db, {
      id,
      mime,
      size: bytes.byteLength,
      filename,
      hash,
      width: dims?.width,
      height: dims?.height,
      owner: actor.actor,
    });

    return c.json(rowToAttachment(config, row), 201);
  });

  // -- GET /api/media/:id (serve the blob; unauthenticated, see file header) -
  router.get("/:id", async (c) => {
    const { config, db } = c.var;
    const id = c.req.param("id");

    const row = getMediaRow(db, id);
    if (!row) throw AppError.notFound({ detail: "no such media" });

    const bytes = await storageFor(config.mediaDir).get(id);
    if (!bytes) {
      // Row exists but the blob is gone (manual deletion / storage drift).
      throw AppError.notFound({ detail: "media blob is missing" });
    }

    // Copy into a fresh ArrayBuffer-backed view so the body is a plain
    // `BodyInit` (the storage backend may hand back a view over an
    // `ArrayBufferLike`). Bun streams the bytes. `content-length` comes from the
    // stored row (the blob is the same size).
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": row.mime,
        "content-length": String(row.size),
        "cache-control": MEDIA_CACHE_CONTROL,
      },
    });
  });

  return router;
}
