/**
 * User device keys (spec §4.3, §4.6, §4.7).
 *
 * A device key is an Ed25519 public key registered to a local user `handle`.
 * Registration is authorized by a single-use bootstrap token (§4.3.1), which is
 * the *sole* source of the binding handle — the client can never choose it. The
 * private half never leaves the client; only the public key is stored and served.
 *
 * This module owns the storage + lifecycle helpers:
 *  - {@link registerDeviceKey}: validate + persist a new key, minting a `key_id`.
 *  - {@link resolveActorKeys}: the **non-revoked** keys for a handle. The signed-
 *    request verification middleware (next card) calls this to look up the key
 *    named by `X-OFSCP-Key-ID` for a *local* actor (P7 handles remote actors).
 *  - {@link revokeDeviceKey}: soft-delete a key (only if it belongs to the
 *    handle). After revocation the key disappears from {@link resolveActorKeys}
 *    and from the §4.6 keys endpoint.
 *
 * The HTTP surface for registration + the public keys endpoint lives in
 * `http/device-keys.ts`; the authenticated revoke/list endpoints land with the
 * signed-request middleware in the next card.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type DeviceKeyRow, deviceKeys } from "../db/schema.ts";

/** A stored device-key record (mirrors the `device_keys` row). */
export type DeviceKeyRecord = DeviceKeyRow;

/** `key_id` prefix, per the §4.3 wire examples (`dk_…`). */
const KEY_ID_PREFIX = "dk_";
/** Random bytes of entropy for a key id (16 = 128 bits). */
const KEY_ID_BYTES = 16;

/** Raw byte length of an Ed25519 public key. */
const ED25519_PUBLIC_KEY_BYTES = 32;

/** Base64url-encode (URL-safe, no padding) for an opaque id body. */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated `key_id` (`dk_<base64url>`). */
function mintKeyId(): string {
  const raw = new Uint8Array(KEY_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${KEY_ID_PREFIX}${toBase64Url(raw)}`;
}

/**
 * Validate that `publicKey` is a well-formed base64-encoded raw Ed25519 public
 * key (decodes cleanly to exactly 32 bytes, and re-encodes to the same value so
 * a non-canonical / truncated string is rejected). Returns false on any
 * malformed input rather than throwing.
 */
export function isValidEd25519PublicKey(publicKey: string): boolean {
  if (typeof publicKey !== "string" || publicKey.length === 0) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(publicKey, "base64");
  } catch {
    return false;
  }
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) return false;
  // Reject inputs that are not canonical base64 of the decoded bytes (e.g. junk
  // that base64 silently drops). Compare against the standard re-encoding.
  return bytes.toString("base64") === publicKey;
}

/** Input to {@link registerDeviceKey}. The handle comes from the token, not here. */
export interface RegisterDeviceKeyInput {
  /** Binding handle, taken from the consumed bootstrap token (§4.3.1). */
  readonly handle: string;
  /** Base64 raw 32-byte Ed25519 public key (already validated by the caller). */
  readonly publicKey: string;
  /** Human-readable device description. */
  readonly deviceName: string;
}

/**
 * Persist a new device key bound to `input.handle`, minting a provider-generated
 * `key_id`. Returns the stored record. The caller is responsible for having
 * validated the public key (see {@link isValidEd25519PublicKey}) and consumed
 * the bootstrap token first.
 */
export function registerDeviceKey(db: Db, input: RegisterDeviceKeyInput): DeviceKeyRecord {
  const row: DeviceKeyRecord = {
    keyId: mintKeyId(),
    userHandle: input.handle,
    publicKey: input.publicKey,
    algorithm: "Ed25519",
    deviceName: input.deviceName,
    createdAt: Date.now(),
    revoked: false,
  };
  db.drizzle.insert(deviceKeys).values(row).run();
  return row;
}

/**
 * The non-revoked device keys for a local `handle`, oldest first. The signed-
 * request verification middleware uses this to resolve the key named by
 * `X-OFSCP-Key-ID` (§4.5 step 6) for a local actor; a revoked key is absent, so
 * it cannot authenticate.
 */
export function resolveActorKeys(db: Db, handle: string): DeviceKeyRecord[] {
  return db.drizzle
    .select()
    .from(deviceKeys)
    .where(eq(deviceKeys.userHandle, handle))
    .orderBy(deviceKeys.createdAt)
    .all()
    .filter((row) => !row.revoked);
}

/**
 * Mark a device key revoked (§4.7.1). The revocation only applies if the key
 * exists *and* belongs to `handle` — a caller cannot revoke another user's key.
 * Returns true if a key was newly revoked, false if no matching active key was
 * found (unknown id, wrong owner, or already revoked).
 *
 * After this returns true the key is gone from {@link resolveActorKeys} and from
 * the §4.6 keys endpoint.
 */
export function revokeDeviceKey(db: Db, handle: string, keyId: string): boolean {
  // Scope the update to (key_id, owner, not-already-revoked) so it is a no-op
  // for another user's key or a double-revoke. Use the raw handle for `.changes`.
  const result = db.sqlite
    .prepare(
      "UPDATE device_keys SET revoked = 1 WHERE key_id = ? AND user_handle = ? AND revoked = 0",
    )
    .run(keyId, handle);
  return result.changes > 0;
}
