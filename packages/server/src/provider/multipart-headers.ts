/**
 * The declared `Content-Type` of each part of a `multipart/form-data` body
 * (RFC 7578), read from the raw bytes.
 *
 * §5.8 lets a provider record "the declared type of the `file` part (its
 * `Content-Type`)". Bun's `FormData` parser does not expose that header: a
 * part's `File.type` is derived from its filename extension, whatever the part
 * declared (a `clip.mp4` part declared `image/png` reads as `video/mp4`). So
 * the upload route reads the part headers itself, here, and pairs them with
 * the parsed parts by name. Only headers are read; part bodies are skipped.
 */

/** One part's name and declared type (`null` when it sent no `Content-Type`). */
export interface PartHeaders {
  readonly name: string;
  readonly contentType: string | null;
}

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

/**
 * The headers of every part of `body` (sent with content type `contentType`),
 * in order. Parts without a `Content-Disposition` name are skipped; a body
 * that is not multipart yields no parts.
 */
export function multipartPartHeaders(body: Uint8Array, contentType: string): PartHeaders[] {
  const boundary = boundaryOf(contentType);
  if (boundary === null) return [];
  // Latin-1 maps each byte to one code unit, so offsets in the string are
  // offsets in the bytes and no byte sequence fails to decode.
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("latin1");
  const delimiter = `--${boundary}`;
  const parts: PartHeaders[] = [];
  // The first delimiter may open the body; each later one follows a CRLF.
  let at = text.startsWith(delimiter) ? 0 : text.indexOf(`\r\n${delimiter}`);
  if (at > 0) at += 2;
  while (at >= 0) {
    const afterDelimiter = at + delimiter.length;
    if (text.startsWith("--", afterDelimiter)) break; // the close delimiter
    const headersStart = text.indexOf("\r\n", afterDelimiter);
    if (headersStart < 0) break;
    const headersEnd = text.indexOf("\r\n\r\n", headersStart);
    if (headersEnd < 0) break;
    let name: string | null = null;
    let partType: string | null = null;
    for (const line of text.slice(headersStart + 2, headersEnd).split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (field === "content-disposition") name = dispositionName(value);
      else if (field === "content-type") partType = value;
    }
    if (name !== null) parts.push({ name, contentType: partType });
    const next = text.indexOf(`\r\n${delimiter}`, headersEnd);
    at = next < 0 ? -1 : next + 2;
  }
  return parts;
}
