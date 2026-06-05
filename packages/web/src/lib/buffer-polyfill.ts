/**
 * Minimal browser `Buffer` shim.
 *
 * `@forumall/shared` (`signing.ts`, `ws-auth.ts`) encodes/decodes keys,
 * signatures and digests through Node's `Buffer` (`Buffer.from(bytes)
 * .toString("base64" | "base64url" | "hex")` and `Buffer.from(str, "base64" |
 * "hex")`). Under Bun (server + tests) `Buffer` is native, so this file is a
 * no-op there. In the browser bundle there is no `Buffer`, so we install a tiny
 * implementation covering ONLY the surface the shared signing code uses.
 *
 * Importing this module for its side effect (top of `main.tsx`, before any code
 * that touches signing) makes the signing primitives work in the browser
 * without pulling in a full polyfill dependency.
 */

function bytesToBase64(bytes: Uint8Array): string {
  // Use the platform btoa over a binary string (chunked to avoid call-stack
  // limits on large inputs — keys/sigs are tiny, but stay safe).
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  // Accept base64url too: normalize and re-pad.
  let s = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4 !== 0) s += "=";
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** A `Uint8Array` extended with the `.toString(encoding)` the shared code calls. */
class BufferShim extends Uint8Array {
  override toString(encoding?: string): string {
    if (encoding === "base64") return bytesToBase64(this);
    if (encoding === "base64url") {
      return bytesToBase64(this).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    if (encoding === "hex") return bytesToHex(this);
    // utf8 / default.
    return new TextDecoder().decode(this);
  }
}

const BufferCtor = {
  from(input: ArrayLike<number> | Uint8Array | string, encoding?: string): BufferShim {
    if (typeof input === "string") {
      if (encoding === "base64" || encoding === "base64url") {
        return new BufferShim(base64ToBytes(input));
      }
      if (encoding === "hex") return new BufferShim(hexToBytes(input));
      return new BufferShim(new TextEncoder().encode(input));
    }
    return new BufferShim(input);
  },
};

// Install only if absent (native Buffer under Bun/Node stays untouched).
const g = globalThis as unknown as { Buffer?: unknown };
if (typeof g.Buffer === "undefined") {
  g.Buffer = BufferCtor;
}

export {};
