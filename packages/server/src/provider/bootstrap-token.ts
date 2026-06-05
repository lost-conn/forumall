/**
 * Bootstrap tokens (spec §4.2).
 *
 * A bootstrap token is the ONLY bearer credential in OFSCP. It is minted on a
 * successful password register/login and authorizes exactly one action:
 * `POST /api/auth/device-keys`, and only for the handle that authenticated.
 *
 * Properties enforced here:
 *  - **≥128 bits entropy, opaque, URL-safe**: 32 random bytes (256 bits)
 *    base64url-encoded, prefixed `bt_` (matching the §4.1 examples).
 *  - **Hashed at rest**: only the SHA-256 hash of the token is stored, so a DB
 *    leak cannot be replayed.
 *  - **Short-lived**: TTL from `config.bootstrapTtlSeconds` (default 300s).
 *  - **Single-use**: {@link consumeBootstrapToken} atomically marks the row used
 *    on the first successful consumption; a second attempt returns null.
 *  - **Handle bound by the token, not the client**: the bound handle is captured
 *    at issue time and returned by consume/verify — callers MUST use it and MUST
 *    NOT trust any client-supplied handle.
 *
 * The next card (device-key registration) calls {@link consumeBootstrapToken} to
 * authorize + resolve the bound handle.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { bootstrapTokens } from "../db/schema.ts";

/** Token prefix, per the §4.1 wire examples (`bt_…`). */
const TOKEN_PREFIX = "bt_";
/** Random bytes of entropy (32 = 256 bits, well above the 128-bit minimum). */
const TOKEN_BYTES = 32;

/** Base64url-encode (URL-safe, no padding) for an opaque token body. */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 hash (hex) of a token's full string — the at-rest lookup key. */
function hashToken(token: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(token)));
}

/** Result of issuing a bootstrap token. */
export interface IssuedBootstrapToken {
  /** The opaque plaintext token to return to the client (shown once). */
  readonly token: string;
  /** TTL in seconds (for the `expires_in` response field). */
  readonly expiresIn: number;
}

/**
 * Mint and persist a single-use bootstrap token bound to `handle`. Stores only
 * the token hash; the plaintext is returned to the caller and never persisted.
 *
 * @param ttlSeconds token lifetime (defaults to 300s if omitted).
 */
export function issueBootstrapToken(
  db: Db,
  handle: string,
  ttlSeconds = 300,
): IssuedBootstrapToken {
  const raw = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(raw);
  const token = `${TOKEN_PREFIX}${toBase64Url(raw)}`;

  const now = Date.now();
  db.drizzle
    .insert(bootstrapTokens)
    .values({
      tokenHash: hashToken(token),
      handle,
      expiresAt: now + ttlSeconds * 1000,
      createdAt: now,
      usedAt: null,
    })
    .run();

  return { token, expiresIn: ttlSeconds };
}

/**
 * Non-consuming validation: look up a bootstrap token by its hash and, if it is
 * present, unexpired, and unused, return the bound `handle`. Otherwise null.
 *
 * Does NOT mark the token used — use {@link consumeBootstrapToken} for the
 * single-use device-key flow. Useful for a cheap pre-check.
 */
export function verifyBootstrapToken(db: Db, token: string): { handle: string } | null {
  const row = db.drizzle
    .select()
    .from(bootstrapTokens)
    .where(eq(bootstrapTokens.tokenHash, hashToken(token)))
    .limit(1)
    .all()[0];

  if (!row) return null;
  if (row.usedAt !== null) return null;
  if (Date.now() >= row.expiresAt) return null;
  return { handle: row.handle };
}

/**
 * Consume a bootstrap token: validate (exists, unexpired, unused) and atomically
 * mark it used, returning the bound `handle`. Returns null if the token is
 * unknown, expired, or already used.
 *
 * Single-use is enforced atomically: the UPDATE sets `used_at` only where it is
 * still NULL, so two concurrent consumers race on the row and exactly one wins
 * (the other sees zero changed rows → null). The returned handle is the binding
 * captured at issue time; callers MUST use it and MUST NOT accept a
 * client-supplied handle (§4.3.1).
 */
export function consumeBootstrapToken(db: Db, token: string): { handle: string } | null {
  const tokenHash = hashToken(token);
  const now = Date.now();

  const row = db.drizzle
    .select()
    .from(bootstrapTokens)
    .where(eq(bootstrapTokens.tokenHash, tokenHash))
    .limit(1)
    .all()[0];

  if (!row) return null;
  if (now >= row.expiresAt) return null;
  // usedAt non-null → already consumed (the atomic UPDATE below also guards it).

  // Atomic single-use claim: the conditional UPDATE flips `used_at` only while
  // it is still NULL, so two concurrent consumers race on the row and exactly
  // one sees a non-zero change count. We go through the raw bun:sqlite handle
  // because it surfaces the affected-row count (`.changes`) that the claim
  // hinges on; drizzle's `.run()` discards it.
  const claimed = db.sqlite
    .prepare(
      "UPDATE bootstrap_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
    )
    .run(now, tokenHash);

  if (claimed.changes < 1) return null;

  return { handle: row.handle };
}
