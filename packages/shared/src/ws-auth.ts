/**
 * OFSCP WebSocket `authenticate` signing primitive (spec §7.1, "Authentication").
 *
 * The WS upgrade itself is not signed; instead the connection authenticates
 * with a signed first message over a server-issued challenge nonce. This module
 * builds the byte-exact canonical string for that `authenticate` command and
 * signs/verifies it with the same Ed25519 setup as `signing.ts`.
 *
 * Imported by both the server (verify) and the web client (sign).
 */
import * as ed from "@noble/ed25519";

import {
  type PrivateKeyInput,
  type PublicKeyInput,
  canonicalAuthority,
} from "./signing.ts";

// `signing.ts` already wires `ed.etc.sha512Sync` at module load; importing from
// it above guarantees that setup runs before any sign/verify call here.

const utf8 = new TextEncoder();

/**
 * Fixed literal that distinguishes the WS-auth canonical string from the
 * request-signing one (spec §7.1). Pinned on line 2 of the canonical string.
 */
export const WS_AUTHENTICATE_TAG = "ofscp-ws-authenticate" as const;

// ---------------------------------------------------------------------------
// base64 helpers (Buffer is fine: server-side, and shimmed in the web bundle).
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function decodeKey(key: Uint8Array | string): Uint8Array {
  if (key instanceof Uint8Array) return key;
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return new Uint8Array(Buffer.from(key, "hex"));
  }
  return fromBase64(key);
}

// ---------------------------------------------------------------------------
// Canonical string (spec §7.1)
// ---------------------------------------------------------------------------

/** Inputs to the WS-authenticate canonical string. */
export interface WsAuthCanonicalParts {
  /**
   * Provider host, optionally with `:port`. Canonicalized exactly as §4.4.2:
   * lowercased, default `:443` stripped. e.g. `providera.com`.
   */
  authority: string;
  /** The `nonce` from the server's `auth.challenge` event. */
  challengeNonce: string;
  /** Exact `authenticate` timestamp (RFC 3339 UTC). */
  timestamp: string;
}

/**
 * Build the 4-line WS-authenticate canonical string (spec §7.1): single LF
 * separators, NO trailing newline, UTF-8.
 *
 *   <authority>
 *   ofscp-ws-authenticate
 *   <challenge-nonce>
 *   <timestamp>
 */
export function buildWsAuthCanonicalString(parts: WsAuthCanonicalParts): string {
  return [
    canonicalAuthority(parts.authority),
    WS_AUTHENTICATE_TAG,
    parts.challengeNonce,
    parts.timestamp,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SignWsAuthInput {
  privateKey: PrivateKeyInput;
  authority: string;
  challengeNonce: string;
  timestamp: string;
}

export interface SignWsAuthResult {
  /** Base64 Ed25519 signature over the canonical string. */
  signature: string;
  /** The exact canonical string that was signed (useful for debugging). */
  canonicalString: string;
}

/**
 * Sign the WS `authenticate` canonical string (spec §7.1). The returned
 * `signature` goes into the `authenticate` command's `data.signature`.
 */
export function signWsAuthenticate(input: SignWsAuthInput): SignWsAuthResult {
  const canonicalString = buildWsAuthCanonicalString(input);
  const sig = ed.sign(utf8.encode(canonicalString), decodeKey(input.privateKey));
  return { signature: toBase64(sig), canonicalString };
}

// ---------------------------------------------------------------------------
// Verification (spec §7.1 step 3 — the cryptographic check only)
// ---------------------------------------------------------------------------

export interface VerifyWsAuthInput {
  publicKey: PublicKeyInput;
  authority: string;
  challengeNonce: string;
  timestamp: string;
  /** Base64 signature from the `authenticate` command. */
  signature: string;
}

/**
 * Reconstruct the WS-auth canonical string and verify the Ed25519 signature.
 * Returns `true` iff the signature is valid. Never throws.
 *
 * NOTE: this is only the crypto check (§7.1 step 3). The server still enforces
 * that the challenge nonce is the one it issued for this connection and is
 * unused/unexpired, plus key resolution (§4.5 steps 3, 6).
 */
export function verifyWsAuthenticate(input: VerifyWsAuthInput): boolean {
  const canonicalString = buildWsAuthCanonicalString({
    authority: input.authority,
    challengeNonce: input.challengeNonce,
    timestamp: input.timestamp,
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
