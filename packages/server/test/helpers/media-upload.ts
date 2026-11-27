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

/** An extra file part sent after `file` (e.g. a `thumbnail`). `mime` "" sends no `Content-Type`. */
export interface FilePart {
  readonly name: string;
  readonly filename: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

/** The headers of one file part. */
function filePartHead(name: string, filename: string, mime: string): string {
  const type = mime === "" ? "" : `Content-Type: ${mime}\r\n`;
  return (
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n${type}\r\n`
  );
}

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
 * Hand-build a `multipart/form-data` body with a `file` part (no
 * `Content-Type` when `mime` is ""), preceded by any extra text `fields` and
 * followed by any extra `files`. Returns the exact bytes (so the signed digest
 * matches) and the content-type header.
 */
export function buildMultipart(
  fileBytes: Uint8Array,
  filename: string,
  mime: string,
  fields: FormFields = [],
  files: readonly FilePart[] = [],
) {
  const enc = new TextEncoder();
  const fieldParts = fields
    .map(
      ([name, value]) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
    .join("");
  const chunks: Uint8Array[] = [enc.encode(fieldParts)];
  for (const part of [{ name: "file", filename, mime, bytes: fileBytes }, ...files]) {
    chunks.push(enc.encode(filePartHead(part.name, part.filename, part.mime)), part.bytes);
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${BOUNDARY}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
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
  files: readonly FilePart[] = [],
): Promise<Response> {
  const path = "/api/media";
  const authority = signer.actor.slice(signer.actor.indexOf("@") + 1);
  const { body, contentType } = buildMultipart(fileBytes, filename, mime, fields, files);
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
