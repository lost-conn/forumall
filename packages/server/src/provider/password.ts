/**
 * Argon2id password hashing + verification (spec §4.1.4).
 *
 * Uses the pure-JS / wasm-free `@noble/hashes/argon2` implementation — no native
 * build step, satisfying the self-host requirement. The raw KDF output is
 * wrapped in the standard **PHC string** format
 * (`$argon2id$v=19$m=<kib>,t=<iters>,p=<lanes>$<b64salt>$<b64hash>`) so a stored
 * hash is fully self-describing: verification reads the salt and cost params
 * straight out of the string, no side table needed.
 *
 * Cost params come from {@link Argon2Params} (config-driven). The env loader
 * (`config.ts`) refuses values below the §4.1.4 minimums, so production hashing
 * is always at/above 64 MiB / 3 iters / 4 lanes. Tests may pass reduced params
 * directly to {@link hashPassword} to keep the suite fast.
 */
import { argon2id } from "@noble/hashes/argon2";

import type { Argon2Params } from "../config.ts";

/** Argon2 version constant (RFC 9106 / 0x13 = 19). */
const ARGON2_VERSION = 19;
/** Salt length in bytes (§4.1.4 minimum). */
const SALT_BYTES = 16;
/** Derived-key length in bytes (32 = 256 bits, the common default). */
const HASH_BYTES = 32;

/** Standard (un-padded) base64 used by the PHC string format. */
function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Hash a password with Argon2id and return a self-contained PHC string.
 *
 * A fresh 16-byte random salt is generated per call, so the same password
 * produces distinct hashes. The returned string starts with `$argon2id$` and
 * embeds the version, cost params, salt, and digest.
 */
export function hashPassword(password: string, params: Argon2Params): string {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);

  const hash = argon2id(password, salt, {
    m: params.memoryKib,
    t: params.iterations,
    p: params.parallelism,
    version: ARGON2_VERSION,
    dkLen: HASH_BYTES,
  });

  const m = params.memoryKib;
  const t = params.iterations;
  const p = params.parallelism;
  return `$argon2id$v=${ARGON2_VERSION}$m=${m},t=${t},p=${p}$${toB64(salt)}$${toB64(hash)}`;
}

interface ParsedPhc {
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
  readonly version: number;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

/** Parse an `$argon2id$…` PHC string into its components, or return null. */
function parsePhc(phc: string): ParsedPhc | null {
  // $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
  const parts = phc.split("$");
  if (parts.length !== 6) return null;
  const [, algo, versionPart, costPart, saltB64, hashB64] = parts;
  if (algo !== "argon2id") return null;

  const versionMatch = /^v=(\d+)$/.exec(versionPart ?? "");
  const costMatch = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(costPart ?? "");
  if (!versionMatch || !costMatch || !saltB64 || !hashB64) return null;

  return {
    version: Number(versionMatch[1]),
    memoryKib: Number(costMatch[1]),
    iterations: Number(costMatch[2]),
    parallelism: Number(costMatch[3]),
    salt: fromB64(saltB64),
    hash: fromB64(hashB64),
  };
}

/** Constant-time comparison of two byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Verify a candidate password against a stored Argon2id PHC string. Re-derives
 * the digest using the salt + params embedded in the stored hash and compares
 * in constant time. Returns false (never throws) on a malformed stored hash.
 */
export function verifyPassword(password: string, phc: string): boolean {
  const parsed = parsePhc(phc);
  if (!parsed) return false;

  const candidate = argon2id(password, parsed.salt, {
    m: parsed.memoryKib,
    t: parsed.iterations,
    p: parsed.parallelism,
    version: parsed.version,
    dkLen: parsed.hash.length,
  });

  return timingSafeEqual(candidate, parsed.hash);
}
