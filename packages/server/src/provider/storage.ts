/**
 * Pluggable blob storage for media attachments (spec §5.8).
 *
 * The provider stores uploaded files behind a tiny {@link StorageBackend}
 * interface so the persistence layer is swappable: the self-host default is the
 * zero-dependency {@link FsStorage} (one file per blob on the local filesystem),
 * and a future card can drop in an S3-backed implementation behind the same
 * three methods without touching the upload/serve routes.
 *
 * The interface is intentionally minimal — content-addressed-ish by the caller's
 * opaque `id` (the attachment id), with the `mime` passed through to `put` so an
 * object-store backend can persist it as object metadata. {@link FsStorage}
 * stores raw bytes only (the mime lives in the `media` DB row), so it ignores
 * the `mime` argument; it is part of the contract for richer backends.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Blob storage abstraction. Implementations persist raw bytes keyed by an opaque
 * `id` (the attachment id). All methods are async so an object-store backend
 * fits the same shape.
 */
export interface StorageBackend {
  /**
   * Store `bytes` under `id`. `mime` is advisory metadata for backends that
   * persist content-type alongside the object (FS ignores it). Overwrites any
   * existing blob with the same id.
   */
  put(id: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** Read the blob stored under `id`, or `null` if there is none. */
  get(id: string): Promise<Uint8Array | null>;
  /** Delete the blob stored under `id`. A missing blob is not an error. */
  delete(id: string): Promise<void>;
}

/**
 * Local-filesystem {@link StorageBackend}, rooted at a directory (`config.mediaDir`).
 * Each blob is a single file named by its id. Zero external dependencies — the
 * self-host default.
 *
 * The root directory is created lazily (and recursively) on first `put`, so a
 * fresh install with no `media/` dir just works. Ids are provider-minted
 * (`att_<base64url>`), so they never contain path separators; we still confine
 * every operation to the root via {@link safePath}, which rejects an id that
 * would escape the directory, as defense-in-depth.
 */
export class FsStorage implements StorageBackend {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Resolve `id` to an absolute path inside the root, rejecting any id that
   * contains a path separator or `..` (which could otherwise escape the root).
   */
  #safePath(id: string): string {
    if (id.length === 0 || id.includes("/") || id.includes("\\") || id.includes("..")) {
      throw new Error(`unsafe media id: ${JSON.stringify(id)}`);
    }
    return join(this.#root, id);
  }

  async put(id: string, bytes: Uint8Array, _mime: string): Promise<void> {
    const path = this.#safePath(id);
    await mkdir(this.#root, { recursive: true });
    await writeFile(path, bytes);
  }

  async get(id: string): Promise<Uint8Array | null> {
    const path = this.#safePath(id);
    try {
      const buf = await readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const path = this.#safePath(id);
    await rm(path, { force: true });
  }
}
