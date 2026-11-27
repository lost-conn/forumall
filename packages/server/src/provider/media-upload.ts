/**
 * Reading a single-step upload (`POST /api/media`, spec §5.8) into what the
 * provider stores: the `file` part, the optional `thumbnail` part, the
 * optional `target` part, and the `width` / `height` / `durationMs` hints.
 *
 * Every failure is reported, not thrown, as the status §5.8 gives it — `400`
 * for a malformed form, `413` for a part over the size limit — so the HTTP
 * layer (`http/media.ts`) maps it to an `AppError` and nothing is stored.
 *
 *  - **`target`** (*Target*): the authority of the provider that will hold the
 *    messages using the upload. It is converted to canonical form (§2.2) and
 *    must then be a canonical authority, else `400`. Omitted, or naming this
 *    provider, it is a **local** upload (`target: null`); anything else is a
 *    **remote** upload, recorded with its canonical authority.
 *  - **`mime`** of each stored part comes from {@link determineUploadMime}: the
 *    part's declared `Content-Type`, but an inline type only when the bytes
 *    confirm it. The declared type is read from the raw part headers
 *    (`multipart-headers.ts`), not `File.type`, which Bun derives from the
 *    filename.
 *  - **`thumbnail`** (*Thumbnail*): a second file part, stored as an upload of
 *    its own. One that is not an `image/*` file — by the recorded `mime`, so an
 *    image type its bytes do not confirm counts as not an image — is a `400`;
 *    one over the size limit is a `413`.
 */
import { canonicalAuthority, isCanonicalAuthority } from "@forumall/shared";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { MediaRow } from "../db/schema.ts";
import { determineUploadMime } from "./media-type.ts";
import {
  type UploaderHints,
  contentHash,
  insertMediaRow,
  mintMediaId,
  parseImageDimensions,
  parseUploaderHints,
  resolveMediaDimensions,
} from "./media.ts";
import type { PartHeaders } from "./multipart-headers.ts";
import type { StorageBackend } from "./storage.ts";

/** One file part, read and typed, ready to store. */
export interface UploadFile {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly filename?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly durationMs?: number | undefined;
}

/** A read upload: the file, its optional thumbnail, and its target. */
export interface ReadUpload {
  readonly file: UploadFile;
  readonly thumbnail: UploadFile | null;
  /** Canonical authority of a remote target; `null` for a local upload. */
  readonly target: string | null;
}

/** Why an upload is refused, with the status §5.8 gives it. */
export interface UploadRefusal {
  readonly status: 400 | 413;
  readonly detail: string;
}

export type ReadUploadOutcome =
  | { readonly upload: ReadUpload; readonly refusal?: undefined }
  | { readonly upload?: undefined; readonly refusal: UploadRefusal };

const badRequest = (detail: string): { refusal: UploadRefusal } => ({
  refusal: { status: 400, detail },
});

/**
 * The single value of form part `name`, `undefined` when absent, or an error
 * when it repeats (one upload has one of each part).
 */
function singlePart(
  form: FormData,
  name: string,
): { value: FormDataEntryValue | undefined } | { error: string } {
  const values = form.getAll(name);
  if (values.length > 1) return { error: `\`${name}\` must be sent at most once` };
  return { value: values[0] };
}

/**
 * The upload's target (§5.8 *Target*): `null` (local) when omitted or naming
 * `config.domain`, else the canonical authority of the remote provider; an
 * `error` for a value that is not a valid authority.
 */
export function parseUploadTarget(
  form: FormData,
  config: Config,
): { readonly target: string | null } | { readonly error: string } {
  const part = singlePart(form, "target");
  if ("error" in part) return part;
  if (part.value === undefined) return { target: null };
  if (typeof part.value !== "string") return { error: "`target` must be a text part" };
  const canonical = canonicalAuthority(part.value);
  if (!isCanonicalAuthority(canonical)) {
    return { error: "`target` must be a provider authority (host[:port])" };
  }
  return { target: canonical === canonicalAuthority(config.domain) ? null : canonical };
}

/** Read one file part: its bytes (size-checked), recorded `mime` and filename. */
async function readFilePart(
  file: File,
  name: string,
  declared: readonly PartHeaders[],
  config: Config,
): Promise<{ file: UploadFile } | { refusal: UploadRefusal }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > config.maxUploadBytes) {
    return {
      refusal: {
        status: 413,
        detail: `\`${name}\` exceeds the ${config.maxUploadBytes}-byte limit`,
      },
    };
  }
  const filename = typeof file.name === "string" && file.name.length > 0 ? file.name : undefined;
  const declaredType = declared.find((part) => part.name === name)?.contentType ?? "";
  return { file: { bytes, mime: determineUploadMime(declaredType, bytes), filename } };
}

/** `file` with its dimensions: from its own header, else the uploader's hints (§5.8). */
function withDimensions(file: UploadFile, hints: UploaderHints): UploadFile {
  return { ...file, ...resolveMediaDimensions(parseImageDimensions(file.bytes), hints) };
}

/**
 * Read a parsed `POST /api/media` form (see the module doc), with `declared`
 * the part headers of the same body. Nothing is stored here; a refusal means
 * nothing should be.
 */
export async function readUploadForm(
  form: FormData,
  declared: readonly PartHeaders[],
  config: Config,
): Promise<ReadUploadOutcome> {
  const filePart = singlePart(form, "file");
  if ("error" in filePart) return badRequest(filePart.error);
  if (!(filePart.value instanceof File)) {
    return badRequest("multipart body must include a `file` part");
  }
  const thumbPart = singlePart(form, "thumbnail");
  if ("error" in thumbPart) return badRequest(thumbPart.error);
  if (thumbPart.value !== undefined && !(thumbPart.value instanceof File)) {
    return badRequest("`thumbnail` must be a file part");
  }
  const hinted = parseUploaderHints(form);
  if ("error" in hinted) return badRequest(hinted.error);
  const target = parseUploadTarget(form, config);
  if ("error" in target) return badRequest(target.error);

  const file = await readFilePart(filePart.value, "file", declared, config);
  if ("refusal" in file) return file;

  let thumbnail: UploadFile | null = null;
  if (thumbPart.value !== undefined) {
    const thumb = await readFilePart(thumbPart.value, "thumbnail", declared, config);
    if ("refusal" in thumb) return thumb;
    if (!thumb.file.mime.startsWith("image/")) {
      return badRequest("`thumbnail` must be an image (image/*) file");
    }
    // A thumbnail's dimensions come from its own header; the hint parts
    // describe the `file`.
    thumbnail = withDimensions(thumb.file, {});
  }

  return {
    upload: {
      file: withDimensions(file.file, hinted.hints),
      thumbnail,
      target: target.target,
    },
  };
}

/**
 * Store a read upload for `owner`: each part's bytes in `storage` under a fresh
 * id, then its `media` rows in one transaction — the thumbnail's (with the
 * parent's owner and target, §5.8 *Thumbnail*) and the file's, naming it.
 * Returns the file's row. A failed write removes the blobs already written, so
 * a refused upload leaves nothing behind.
 */
export async function storeUpload(
  db: Db,
  storage: StorageBackend,
  upload: ReadUpload,
  owner: string,
): Promise<MediaRow> {
  const file = { id: mintMediaId(), part: upload.file };
  const thumb = upload.thumbnail !== null ? { id: mintMediaId(), part: upload.thumbnail } : null;
  const written: string[] = [];
  const record = (id: string, part: UploadFile, thumbnailId: string | null) =>
    insertMediaRow(db, {
      id,
      mime: part.mime,
      size: part.bytes.byteLength,
      filename: part.filename,
      hash: contentHash(part.bytes),
      width: part.width,
      height: part.height,
      durationMs: part.durationMs,
      owner,
      target: upload.target,
      thumbnailId,
    });
  try {
    for (const { id, part } of thumb !== null ? [file, thumb] : [file]) {
      await storage.put(id, part.bytes, part.mime);
      written.push(id);
    }
    return db.sqlite.transaction(() => {
      if (thumb !== null) record(thumb.id, thumb.part, null);
      return record(file.id, file.part, thumb?.id ?? null);
    })();
  } catch (err) {
    await Promise.all(written.map((id) => storage.delete(id)));
    throw err;
  }
}
