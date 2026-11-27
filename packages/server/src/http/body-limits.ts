/**
 * Request body size limits, enforced before a body is buffered.
 *
 * The §4.5 signature middleware buffers the whole raw body (step 5, the
 * content digest) before any route handler runs, so a size check inside a
 * handler protects nothing. Two limits apply earlier:
 *
 *  - **Every route:** `Bun.serve`'s `maxRequestBodySize` is set to
 *    {@link maxRequestBodyBytes} (`app.__maxRequestBodySize`, passed by
 *    `index.ts` and the test/e2e harnesses). Bun answers a larger body `413`
 *    while reading it, whatever the route.
 *  - **`POST /api/media`:** {@link uploadBodyLimit} runs before the signature
 *    middleware and holds the body to {@link maxUploadBodyBytes}: a declared
 *    `Content-Length` over it is a `413` before a byte is read, and a body
 *    without one (chunked) is counted as it streams in and refused as soon as
 *    it passes the limit. Each file part is then held to the exact
 *    `MAX_UPLOAD_BYTES` (§5.8) once parsed.
 */
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { Config } from "../config.ts";
import { AppError } from "./errors.ts";
import type { AppBindings } from "./types.ts";

/**
 * Room in a multipart upload for everything but the file bytes: part headers,
 * boundaries and the small text parts (`target`, `width`, `height`,
 * `durationMs`). Generous, since each file part is held to the exact limit.
 */
export const MULTIPART_ENVELOPE_BYTES = 64 * 1024;

/**
 * The largest body an acceptable `POST /api/media` can have: a `file` and a
 * `thumbnail` each at `MAX_UPLOAD_BYTES`, plus the envelope.
 */
export function maxUploadBodyBytes(config: Config): number {
  return 2 * config.maxUploadBytes + MULTIPART_ENVELOPE_BYTES;
}

/**
 * The largest body any route accepts (`Bun.serve`'s `maxRequestBodySize`): an
 * upload ({@link maxUploadBodyBytes}), or a JSON command as large as the
 * WebSocket frame that may carry the same command (`WS_MAX_FRAME_BYTES`; a
 * REST `message.create` must fit what the WS one does), whichever is larger.
 */
export function maxRequestBodyBytes(config: Config): number {
  return Math.max(maxUploadBodyBytes(config), config.wsMaxFrameBytes);
}

/**
 * Holds a `POST /api/media` body to {@link maxUploadBodyBytes} before the
 * signature middleware buffers it (see the module doc). Mount it ahead of
 * `requireSignature()`. The limit comes from the request's `c.var.config`.
 */
export function uploadBodyLimit(): MiddlewareHandler<AppBindings> {
  return (c, next) => {
    const { config } = c.var;
    return bodyLimit({
      maxSize: maxUploadBodyBytes(config),
      onError: () => {
        throw AppError.payloadTooLarge({
          detail: `upload exceeds the ${config.maxUploadBytes}-byte limit`,
        });
      },
    })(c, next);
  };
}
