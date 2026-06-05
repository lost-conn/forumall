/**
 * OFSCP request signing + verification (spec §4.4, §4.5, §8.1).
 *
 * This is the byte-exact authentication core: the canonical string built here
 * must reproduce the published conformance vector exactly, or every signed
 * request in the system silently 401s. Validated against
 * `ofscp/tests/signing-vector.json`.
 *
 * Imported by both the server (verify) and the web client (sign).
 */
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2";

// @noble/ed25519 v2 needs a synchronous SHA-512 wired up before any sync
// sign/verify/getPublicKey call. Set it once at module load.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const utf8 = new TextEncoder();

/** SHA-256 of the empty body, base64. Spec §4.4.1. */
export const EMPTY_BODY_DIGEST = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

// ---------------------------------------------------------------------------
// base64 helpers (Node/Bun Buffer is fine here; this module runs server-side
// and in the bundler-targeted web client where Buffer is shimmed).
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Canonical components (spec §4.4.2)
// ---------------------------------------------------------------------------

/**
 * The request-derived inputs to the canonical string. These describe *what*
 * is being signed (the target + the per-request metadata), independent of the
 * actor/provider identity headers.
 */
export interface CanonicalParts {
  /**
   * Host of the target provider, optionally with `:port`. Case is normalized
   * (lowercased) and a default `:443` port is stripped by `canonicalAuthority`.
   * e.g. `providera.com`, `providera.com:8443`.
   */
  authority: string;
  /** HTTP method; uppercased by the builder. e.g. `POST`. */
  method: string;
  /**
   * Request path exactly as sent, including the leading `/`, with NO
   * dot-segment collapsing or trailing-slash normalization. Empty → `/`.
   */
  path: string;
  /**
   * Raw query string. Accepts either the raw `name=value&...` string (exactly
   * as sent, before percent-decoding, with or without a leading `?`) or an
   * array of raw `name=value` pieces. Sorted ascending by byte order.
   */
  query?: string | string[];
  /** Exact `X-OFSCP-Timestamp` value (RFC 3339 UTC). */
  timestamp: string;
  /** Exact `X-OFSCP-Nonce` value (base64url, ≥128 bits). */
  nonce: string;
  /** Exact `X-OFSCP-Content-Digest` value: `base64(SHA-256(body))`. */
  contentDigest: string;
}

/** `base64( SHA-256( raw body bytes ) )`. Spec §4.4.1. */
export function contentDigest(bodyBytes: Uint8Array | string): string {
  const bytes = typeof bodyBytes === "string" ? utf8.encode(bodyBytes) : bodyBytes;
  if (bytes.length === 0) return EMPTY_BODY_DIGEST;
  return toBase64(sha256(bytes));
}

/**
 * Normalize the authority line: lowercase host; append `:port` only when the
 * port is present and non-default (not 443).
 */
export function canonicalAuthority(authority: string): string {
  const lower = authority.trim().toLowerCase();
  const colon = lower.lastIndexOf(":");
  // No port, or an IPv6 literal without a port (e.g. `[::1]`).
  if (colon === -1 || lower.endsWith("]")) return lower;
  const host = lower.slice(0, colon);
  const port = lower.slice(colon + 1);
  if (port === "443" || port === "") return host;
  return `${host}:${port}`;
}

/**
 * Normalize the path line: exactly as sent (no dot-segment collapsing, no
 * trailing-slash normalization), but strip any query/fragment and default an
 * empty path to `/`.
 */
export function canonicalPath(path: string): string {
  let p = path;
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf("#");
  if (h !== -1) p = p.slice(0, h);
  return p === "" ? "/" : p;
}

/**
 * Normalize the query line: raw `name=value` pairs exactly as sent (before
 * percent-decoding), sorted ascending by byte order, joined with `&`, leading
 * `?` omitted. No query → empty string (the line still exists).
 */
export function canonicalQuery(query: string | string[] | undefined): string {
  if (query === undefined) return "";
  let pieces: string[];
  if (Array.isArray(query)) {
    pieces = query.filter((p) => p.length > 0);
  } else {
    let raw = query;
    if (raw.startsWith("?")) raw = raw.slice(1);
    if (raw === "") return "";
    pieces = raw.split("&").filter((p) => p.length > 0);
  }
  // Ascending byte order. JS string `<` compares UTF-16 code units; for the
  // ASCII subset that query strings occupy this equals byte order. Compare on
  // a per-byte basis to be exact for any UTF-8 content.
  pieces.sort(byteCompare);
  return pieces.join("&");
}

function byteCompare(a: string, b: string): number {
  const ab = utf8.encode(a);
  const bb = utf8.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const diff = (ab[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return ab.length - bb.length;
}

/**
 * Build the 7-line canonical string (spec §4.4.2): single LF separators, NO
 * trailing newline, UTF-8.
 */
export function buildCanonicalString(parts: CanonicalParts): string {
  return [
    canonicalAuthority(parts.authority),
    parts.method.toUpperCase(),
    canonicalPath(parts.path),
    canonicalQuery(parts.query),
    parts.timestamp,
    parts.nonce,
    parts.contentDigest,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Per-request metadata helpers
// ---------------------------------------------------------------------------

/** RFC 3339 UTC timestamp (seconds precision, trailing `Z`). Spec §4.4.1. */
export function rfc3339Timestamp(date: Date = new Date()): string {
  // toISOString() yields e.g. 2026-01-01T12:00:00.123Z; drop the millis to
  // match the vector / spec example shape.
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Fresh, high-entropy nonce (192 bits → base64url). Spec §4.4.1 (≥128 bits). */
export function generateNonce(byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

/** A private key as a raw 32-byte Ed25519 seed, hex string, or base64 string. */
export type PrivateKeyInput = Uint8Array | string;
/** A public key as raw 32 bytes, hex string, or base64 string. */
export type PublicKeyInput = Uint8Array | string;

function decodeKey(key: Uint8Array | string): Uint8Array {
  if (key instanceof Uint8Array) return key;
  // 64 hex chars → 32-byte raw key.
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return new Uint8Array(Buffer.from(key, "hex"));
  }
  return fromBase64(key);
}

/** Derive the base64 public key from a private seed. */
export function publicKeyFromPrivate(privateKey: PrivateKeyInput): string {
  return toBase64(ed.getPublicKey(decodeKey(privateKey)));
}

// ---------------------------------------------------------------------------
// Signing headers
// ---------------------------------------------------------------------------

/** Canonical OFSCP signing header names. */
export const HEADER = {
  ACTOR: "X-OFSCP-Actor",
  PROVIDER: "X-OFSCP-Provider",
  KEY_ID: "X-OFSCP-Key-ID",
  TIMESTAMP: "X-OFSCP-Timestamp",
  NONCE: "X-OFSCP-Nonce",
  CONTENT_DIGEST: "X-OFSCP-Content-Digest",
  SIGNATURE: "X-OFSCP-Signature",
} as const;

/** Shared shape of inputs needed to produce a signed request. */
export interface SignInputBase {
  privateKey: PrivateKeyInput;
  keyId: string;
  authority: string;
  method: string;
  path: string;
  query?: string | string[];
  /** Raw request body bytes (or string). Defaults to empty. */
  body?: Uint8Array | string;
  /** Override timestamp (RFC 3339 UTC). Defaults to now. */
  timestamp?: string;
  /** Override nonce. Defaults to a fresh 192-bit nonce. */
  nonce?: string;
}

/** User-signed request input (§4.4): identity is an actor. */
export interface SignInput extends SignInputBase {
  /** Actor identifier, e.g. `alice@providera.com`. */
  actor: string;
}

/** Provider-signed request input (§8.1): identity is a provider domain. */
export interface ProviderSignInput extends SignInputBase {
  /** Signing provider's domain. */
  provider: string;
}

export interface SignResult {
  /** Headers to attach to the outgoing request. */
  headers: Record<string, string>;
  /** The exact canonical string that was signed (useful for debugging). */
  canonicalString: string;
}

function deriveParts(input: SignInputBase): {
  parts: CanonicalParts;
  timestamp: string;
  nonce: string;
  digest: string;
} {
  const timestamp = input.timestamp ?? rfc3339Timestamp();
  const nonce = input.nonce ?? generateNonce();
  const digest = contentDigest(input.body ?? new Uint8Array(0));
  return {
    timestamp,
    nonce,
    digest,
    parts: {
      authority: input.authority,
      method: input.method,
      path: input.path,
      query: input.query,
      timestamp,
      nonce,
      contentDigest: digest,
    },
  };
}

function signCanonical(privateKey: PrivateKeyInput, canonicalString: string): string {
  const sig = ed.sign(utf8.encode(canonicalString), decodeKey(privateKey));
  return toBase64(sig);
}

/** Sign a user request (§4.4). Produces `X-OFSCP-Actor` + signing headers. */
export function sign(input: SignInput): SignResult {
  const { parts, timestamp, nonce, digest } = deriveParts(input);
  const canonicalString = buildCanonicalString(parts);
  const signature = signCanonical(input.privateKey, canonicalString);
  return {
    canonicalString,
    headers: {
      [HEADER.ACTOR]: input.actor,
      [HEADER.KEY_ID]: input.keyId,
      [HEADER.TIMESTAMP]: timestamp,
      [HEADER.NONCE]: nonce,
      [HEADER.CONTENT_DIGEST]: digest,
      [HEADER.SIGNATURE]: signature,
    },
  };
}

/** Sign a provider request (§8.1). Produces `X-OFSCP-Provider` + signing headers. */
export function signProvider(input: ProviderSignInput): SignResult {
  const { parts, timestamp, nonce, digest } = deriveParts(input);
  const canonicalString = buildCanonicalString(parts);
  const signature = signCanonical(input.privateKey, canonicalString);
  return {
    canonicalString,
    headers: {
      [HEADER.PROVIDER]: input.provider,
      [HEADER.KEY_ID]: input.keyId,
      [HEADER.TIMESTAMP]: timestamp,
      [HEADER.NONCE]: nonce,
      [HEADER.CONTENT_DIGEST]: digest,
      [HEADER.SIGNATURE]: signature,
    },
  };
}

// ---------------------------------------------------------------------------
// Verification (spec §4.5 step 7 — the cryptographic check only)
// ---------------------------------------------------------------------------

/** Inputs needed to verify a signature against a reconstructed canonical string. */
export interface VerifyInput {
  publicKey: PublicKeyInput;
  authority: string;
  method: string;
  path: string;
  query?: string | string[];
  timestamp: string;
  nonce: string;
  contentDigest: string;
  /** Base64 signature from `X-OFSCP-Signature`. */
  signature: string;
}

/**
 * Reconstruct the canonical string and verify the Ed25519 signature.
 * Returns `true` iff the signature is valid. Never throws on a bad signature.
 *
 * NOTE: this performs only the crypto check (§4.5 step 7). The full request
 * pipeline (header presence, authority match, timestamp skew, nonce replay,
 * body-digest recomputation, key resolution/revocation) is enforced by the
 * server around this primitive.
 */
export function verify(input: VerifyInput): boolean {
  const canonicalString = buildCanonicalString({
    authority: input.authority,
    method: input.method,
    path: input.path,
    query: input.query,
    timestamp: input.timestamp,
    nonce: input.nonce,
    contentDigest: input.contentDigest,
  });
  try {
    return ed.verify(
      fromBase64(input.signature),
      utf8.encode(canonicalString),
      decodeKey(input.publicKey),
    );
  } catch {
    return false;
  }
}

/**
 * Verify directly from a header bag + request target. Reads either the
 * user (`X-OFSCP-Actor`) or provider (`X-OFSCP-Provider`) header shape; the
 * canonical string and crypto check are identical for both (§8.1).
 *
 * Header lookup is case-insensitive.
 */
export function verifyHeaders(args: {
  publicKey: PublicKeyInput;
  authority: string;
  method: string;
  path: string;
  query?: string | string[];
  headers: Record<string, string | undefined> | Headers;
}): boolean {
  const get = headerGetter(args.headers);
  const timestamp = get(HEADER.TIMESTAMP);
  const nonce = get(HEADER.NONCE);
  const digest = get(HEADER.CONTENT_DIGEST);
  const signature = get(HEADER.SIGNATURE);
  if (!timestamp || !nonce || !digest || !signature) return false;
  return verify({
    publicKey: args.publicKey,
    authority: args.authority,
    method: args.method,
    path: args.path,
    query: args.query,
    timestamp,
    nonce,
    contentDigest: digest,
    signature,
  });
}

/** Provider-signed verification from headers (§8.1). Alias of `verifyHeaders`. */
export const verifyProviderHeaders = verifyHeaders;

function headerGetter(
  headers: Record<string, string | undefined> | Headers,
): (name: string) => string | undefined {
  if (headers instanceof Headers) {
    return (name) => headers.get(name) ?? undefined;
  }
  // Case-insensitive lookup over a plain object.
  const lower = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), v);
  return (name) => lower.get(name.toLowerCase());
}
