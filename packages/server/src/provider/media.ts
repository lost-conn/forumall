/**
 * Media store helpers (spec §5.8): id minting, content hashing, best-effort
 * image dimension parsing, and the `media` row ↔ hosted `Attachment` mapping.
 *
 * The HTTP layer (`http/media.ts`) owns request parsing, signing, and the
 * storage-backend call; this module is the pure-ish provider logic so it can be
 * unit-driven and reused (e.g. by a future pre-signed-upload card, §5.8).
 */
import { type Attachment, AttachmentSchema } from "@forumall/shared";
import { sha256 } from "@noble/hashes/sha2";
import { eq } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { type MediaRow, media } from "../db/schema.ts";

/** `id` prefix per the §5.8 wire examples (`att_…`). */
const MEDIA_ID_PREFIX = "att_";
/** Random bytes of entropy for a media id (16 = 128 bits). */
const MEDIA_ID_BYTES = 16;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated media/attachment id (`att_<base64url>`). */
export function mintMediaId(): string {
  const raw = new Uint8Array(MEDIA_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${MEDIA_ID_PREFIX}${toBase64Url(raw)}`;
}

/**
 * Compute the §5.8 content-integrity hash for `bytes`: `sha-256:<base64>`.
 * The base64 is standard (padded), matching the `<algo>:<base64>` form.
 */
export function contentHash(bytes: Uint8Array): string {
  return `sha-256:${Buffer.from(sha256(bytes)).toString("base64")}`;
}

/** Parsed pixel dimensions of an image. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Best-effort width/height extraction from the header bytes of common image
 * formats (PNG, GIF, JPEG, WebP). Returns `null` when the bytes are not a
 * recognized image or the dimensions can't be cheaply parsed — both width and
 * height are optional on `Attachment`, so callers simply omit them.
 *
 * This is a deliberately small header parser (no image library): it reads the
 * few bytes each format puts its dimensions in. It never throws — any malformed
 * input falls through to `null`.
 */
export function parseImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  // All reads go through a DataView so each byte is typed `number` (not
  // `number | undefined`) and an out-of-range offset throws `RangeError`, caught
  // below — so the parser never throws and degrades to `null` on bad input.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (i: number): number => dv.getUint8(i);
  try {
    // PNG: 8-byte signature, then IHDR chunk at offset 16: width/height as BE u32.
    if (
      bytes.length >= 24 &&
      u8(0) === 0x89 &&
      u8(1) === 0x50 &&
      u8(2) === 0x4e &&
      u8(3) === 0x47
    ) {
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }

    // GIF: "GIF87a"/"GIF89a", then logical screen width/height as LE u16.
    if (bytes.length >= 10 && u8(0) === 0x47 && u8(1) === 0x49 && u8(2) === 0x46) {
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    }

    // WebP: RIFF container "RIFF"...."WEBP", VP8/VP8L/VP8X sub-chunk.
    if (
      bytes.length >= 30 &&
      u8(0) === 0x52 &&
      u8(1) === 0x49 &&
      u8(2) === 0x46 &&
      u8(3) === 0x46 &&
      u8(8) === 0x57 &&
      u8(9) === 0x45 &&
      u8(10) === 0x42 &&
      u8(11) === 0x50
    ) {
      const fourcc = String.fromCharCode(u8(12), u8(13), u8(14), u8(15));
      if (fourcc === "VP8 ") {
        // Lossy: 16-bit width/height (14 bits used) at offset 26.
        return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      }
      if (fourcc === "VP8L") {
        // Lossless: 14-bit width-1 / height-1 packed from offset 21.
        const b0 = u8(21);
        const b1 = u8(22);
        const b2 = u8(23);
        const b3 = u8(24);
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height };
      }
      if (fourcc === "VP8X") {
        // Extended: 24-bit (width-1)/(height-1) at offset 24 (LE).
        const width = 1 + (u8(24) | (u8(25) << 8) | (u8(26) << 16));
        const height = 1 + (u8(27) | (u8(28) << 16) | (u8(29) << 8));
        return { width, height };
      }
      return null;
    }

    // JPEG: SOI (0xFFD8), then scan marker segments for a Start-Of-Frame (SOFn).
    if (bytes.length >= 4 && u8(0) === 0xff && u8(1) === 0xd8) {
      let off = 2;
      while (off + 9 < bytes.length) {
        if (u8(off) !== 0xff) {
          off++;
          continue;
        }
        const marker = u8(off + 1);
        // SOF0..SOF15 carry dimensions, excluding DHT(0xC4)/JPG(0xC8)/DAC(0xCC).
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          const height = dv.getUint16(off + 5);
          const width = dv.getUint16(off + 7);
          return { width, height };
        }
        // Skip this segment: 2-byte marker + big-endian segment length.
        const len = dv.getUint16(off + 2);
        if (len < 2) break;
        off += 2 + len;
      }
    }
  } catch {
    // Any out-of-range read / malformed header → no dimensions.
    return null;
  }
  return null;
}

/** Build the hosted attachment URL for a stored blob id. */
export function mediaUrl(config: Config, id: string): string {
  return `https://${config.domain}/api/media/${id}`;
}

/** Inputs to persist a stored upload's metadata. */
export interface StoreMediaInput {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly filename?: string | undefined;
  readonly hash: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** Owning actor (`handle@domain`). */
  readonly owner: string;
}

/** Insert a `media` row for an already-stored blob. */
export function insertMediaRow(db: Db, input: StoreMediaInput): MediaRow {
  const row: MediaRow = {
    id: input.id,
    mime: input.mime,
    size: input.size,
    filename: input.filename ?? null,
    hash: input.hash,
    width: input.width ?? null,
    height: input.height ?? null,
    owner: input.owner,
    createdAt: Date.now(),
  };
  db.drizzle.insert(media).values(row).run();
  return row;
}

/** The raw `media` row for `id`, or `null` if unknown. */
export function getMediaRow(db: Db, id: string): MediaRow | null {
  return db.drizzle.select().from(media).where(eq(media.id, id)).limit(1).all()[0] ?? null;
}

/** Map a stored `media` row to the hosted, schema-valid `Attachment` (§5.8). */
export function rowToAttachment(config: Config, row: MediaRow): Attachment {
  return AttachmentSchema.parse({
    id: row.id,
    mime: row.mime,
    url: mediaUrl(config, row.id),
    size: row.size,
    hash: row.hash,
    ...(row.filename != null ? { filename: row.filename } : {}),
    ...(row.width != null ? { width: row.width } : {}),
    ...(row.height != null ? { height: row.height } : {}),
  });
}
