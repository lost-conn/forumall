/**
 * Signed `POST /api/media` uploads for tests (§5.8). The multipart body is
 * hand-built so the signed bytes and the sent bytes are byte-identical (a
 * `FormData`/`Blob` would re-serialize with its own boundary), and the §4.4
 * content digest is taken over exactly those raw bytes.
 */
import { sign } from "@forumall/shared";

const BOUNDARY = "----forumalltestboundary7MA4YWxkTrZu0gW";

/** Extra text form parts sent beside `file` (`[name, value]`, repeats allowed). */
export type FormFields = readonly (readonly [string, string])[];

/** Anything that answers a request by path: a Hono app, or a wrapper around `fetch`. */
export interface RequestTarget {
  request(path: string, init: RequestInit): Response | Promise<Response>;
}

/** A local user's device key (`actor` = `handle@domain`, its home provider). */
export interface UploadSigner {
  readonly actor: string;
  readonly keyId: string;
  readonly privateKey: string;
}

/**
 * Hand-build a `multipart/form-data` body with a `file` part, preceded by any
 * extra text `fields`. Returns the exact bytes (so the signed digest matches)
 * and the content-type header.
 */
export function buildMultipart(
  fileBytes: Uint8Array,
  filename: string,
  mime: string,
  fields: FormFields = [],
) {
  const enc = new TextEncoder();
  const fieldParts = fields
    .map(
      ([name, value]) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
    .join("");
  const filePart =
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const head = enc.encode(`${fieldParts}${filePart}`);
  const tail = enc.encode(`\r\n--${BOUNDARY}--\r\n`);
  const body = new Uint8Array(head.length + fileBytes.length + tail.length);
  body.set(head, 0);
  body.set(fileBytes, head.length);
  body.set(tail, head.length + fileBytes.length);
  return { body, contentType: `multipart/form-data; boundary=${BOUNDARY}` };
}

/**
 * Upload `fileBytes` as a signed multipart `POST /api/media` to the signer's
 * home provider (the signing authority is the domain of `signer.actor`).
 */
export async function uploadMedia(
  target: RequestTarget,
  signer: UploadSigner,
  fileBytes: Uint8Array,
  filename: string,
  mime: string,
  fields: FormFields = [],
): Promise<Response> {
  const path = "/api/media";
  const authority = signer.actor.slice(signer.actor.indexOf("@") + 1);
  const { body, contentType } = buildMultipart(fileBytes, filename, mime, fields);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority,
    method: "POST",
    path,
    body,
  });
  return target.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": contentType },
    body,
  });
}
