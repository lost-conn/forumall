/**
 * Shared pieces of the §5.8 media sniffer (`media-sniff/*`): the result type
 * and bounds-checked readers over the uploaded bytes. Every reader returns
 * `null` / `false` past the end of the input instead of throwing, so a
 * truncated file is simply "not this format".
 */

/** A format the bytes were recognized as. */
export interface SniffedType {
  /** The type to record when the uploader declared none. */
  readonly primary: string;
  /** Every media type (aliases included) these bytes confirm; `primary` is first. */
  readonly types: readonly string[];
}

/** One format check: the format `bytes` structurally is, or `null`. */
export type Sniffer = (bytes: Uint8Array) => SniffedType | null;

/** A {@link SniffedType} confirming `primary` and its `aliases`. */
export const sniffed = (primary: string, ...aliases: string[]): SniffedType => ({
  primary,
  types: [primary, ...aliases],
});

/** Whether `bytes` holds `sig` starting at `offset`. */
export function hasBytes(bytes: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (offset < 0 || offset + sig.length > bytes.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** Whether `bytes` holds the ASCII string `text` starting at `offset`. */
export function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  return hasBytes(
    bytes,
    offset,
    Array.from(text, (ch) => ch.charCodeAt(0)),
  );
}

/** The ASCII text of `bytes[offset, offset + length)`, or `null` past the end. */
export function asciiAt(bytes: Uint8Array, offset: number, length: number): string | null {
  if (offset < 0 || offset + length > bytes.length) return null;
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * The four-character code at `offset` when all four bytes are printable ASCII
 * (as every box, chunk and brand code of ISO-BMFF, RIFF and IFF is), else `null`.
 */
export function fourcc(bytes: Uint8Array, offset: number): string | null {
  const code = asciiAt(bytes, offset, 4);
  if (code === null) return null;
  for (let i = 0; i < 4; i++) {
    const c = code.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return null;
  }
  return code;
}

/** An unsigned 16-bit integer at `offset` (big-endian unless `le`), or `null` past the end. */
export function u16(bytes: Uint8Array, offset: number, le = false): number | null {
  const [a, b] = [bytes[offset], bytes[offset + 1]];
  if (offset < 0 || a === undefined || b === undefined) return null;
  return le ? a | (b << 8) : (a << 8) | b;
}

/** An unsigned 24-bit big-endian integer at `offset`, or `null` past the end. */
export function u24(bytes: Uint8Array, offset: number): number | null {
  const hi = u16(bytes, offset);
  const lo = bytes[offset + 2];
  if (hi === null || lo === undefined) return null;
  return hi * 0x100 + lo;
}

/** An unsigned 32-bit integer at `offset` (big-endian unless `le`), or `null` past the end. */
export function u32(bytes: Uint8Array, offset: number, le = false): number | null {
  const first = u16(bytes, offset, le);
  const second = u16(bytes, offset + 2, le);
  if (first === null || second === null) return null;
  return le ? first + second * 0x10000 : first * 0x10000 + second;
}
