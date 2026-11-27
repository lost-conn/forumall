/**
 * The declared `Content-Type` of each part of a `multipart/form-data` body
 * (RFC 7578), read from the raw bytes.
 *
 * §5.8 lets a provider record "the declared type of the `file` part (its
 * `Content-Type`)". Bun's `FormData` parser does not expose that header: a
 * part's `File.type` is derived from its filename extension, whatever the part
 * declared (a `clip.mp4` part declared `image/png` reads as `video/mp4`). So
 * the upload route reads the part headers itself, here, and pairs them with
 * the parsed parts by name. Only header blocks are decoded; part bodies are
 * skipped over in place, never copied.
 *
 * Delimiters follow RFC 2046 §5.1.1 exactly: `--boundary` at the start of the
 * body or after a CRLF, then either `--` (the close delimiter) or nothing,
 * then optional transport padding (spaces and tabs) and a CRLF — or, after
 * the close delimiter, the end of the body. `--boundary` followed by anything
 * else is part of a body, not a delimiter, so a part body cannot smuggle in a
 * fake part. Where this parser and Bun's disagree on which named parts a body
 * holds, the upload route refuses the body (`http/media.ts`).
 */

/** One part's name and declared type (`null` when it sent no `Content-Type`). */
export interface PartHeaders {
  readonly name: string;
  readonly contentType: string | null;
}

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const SPACE = 0x20;
const TAB = 0x09;
const CRLF = Buffer.from("\r\n");
const HEADERS_END = Buffer.from("\r\n\r\n");

/** The `boundary` parameter of a `multipart/*` content type, or `null`. */
function boundaryOf(contentType: string): string | null {
  const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2] ?? null;
}

/** The `name` parameter of a `Content-Disposition: form-data` value, or `null`. */
function dispositionName(value: string): string | null {
  // `(?:^|;)` so that `filename=` is never read as `name=`.
  const match = /(?:^|;)\s*name\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(value);
  return match?.[1] ?? match?.[2] ?? null;
}

/** A delimiter line: whether it closes the body, and where the next part's headers start. */
interface Delimiter {
  readonly close: boolean;
  readonly next: number;
}

/**
 * The delimiter whose `--boundary` ends just before `at`, or `null` when what
 * follows makes it no delimiter: after an optional `--`, only transport
 * padding and a CRLF (or, for the close delimiter, the end of the body).
 */
function delimiterAt(body: Buffer, at: number): Delimiter | null {
  const close = body[at] === DASH && body[at + 1] === DASH;
  let i = close ? at + 2 : at;
  while (body[i] === SPACE || body[i] === TAB) i++;
  if (close && i === body.length) return { close, next: i };
  if (body[i] === CR && body[i + 1] === LF) return { close, next: i + 2 };
  return null;
}

/**
 * The first delimiter at or after `from`: `--boundary` opening the body (only
 * when `from` is 0) or following a CRLF, with a valid suffix.
 */
function findDelimiter(body: Buffer, dashBoundary: Buffer, from: number): Delimiter | null {
  if (from === 0 && body.subarray(0, dashBoundary.length).equals(dashBoundary)) {
    const opening = delimiterAt(body, dashBoundary.length);
    if (opening !== null) return opening;
  }
  const crlfBoundary = Buffer.concat([CRLF, dashBoundary]);
  for (
    let at = body.indexOf(crlfBoundary, from);
    at >= 0;
    at = body.indexOf(crlfBoundary, at + 1)
  ) {
    const found = delimiterAt(body, at + crlfBoundary.length);
    if (found !== null) return found;
  }
  return null;
}

/** The name and declared type in one part's header block (`text`, CRLF-separated lines). */
function readHeaderBlock(text: string): { name: string | null; contentType: string | null } {
  let name: string | null = null;
  let contentType: string | null = null;
  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "content-disposition") name = dispositionName(value);
    else if (field === "content-type") contentType = value;
  }
  return { name, contentType };
}

/**
 * The headers of every part of `body` (sent with content type `contentType`),
 * in order, up to the close delimiter. Parts without a `Content-Disposition`
 * name are skipped; a body that is not multipart yields no parts.
 */
export function multipartPartHeaders(body: Uint8Array, contentType: string): PartHeaders[] {
  const boundary = boundaryOf(contentType);
  if (boundary === null) return [];
  // A view over the same memory: indexOf and slicing run on the bytes in place.
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const dashBoundary = Buffer.from(`--${boundary}`, "latin1");
  const parts: PartHeaders[] = [];
  let delimiter = findDelimiter(bytes, dashBoundary, 0);
  while (delimiter !== null && !delimiter.close) {
    // The header block ends at an empty line; with no headers, at once.
    const headersEnd = bytes.indexOf(HEADERS_END, delimiter.next - 2);
    if (headersEnd < 0) break;
    const block =
      headersEnd < delimiter.next ? "" : bytes.toString("latin1", delimiter.next, headersEnd);
    const { name, contentType: partType } = readHeaderBlock(block);
    if (name !== null) parts.push({ name, contentType: partType });
    // The part body starts after the empty line; its final CRLF belongs to the next delimiter.
    delimiter = findDelimiter(bytes, dashBoundary, headersEnd + 2);
  }
  return parts;
}
