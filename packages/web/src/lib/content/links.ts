/**
 * The §5.3 link allow-list, shared by every body format.
 *
 * "Clients MUST NOT make a link active unless its scheme is `http`, `https` or
 * `mailto` (or `attachment`)." A link with any other scheme, and a link with no
 * scheme at all (`/foo`, `#x`, `//host`, `page.html`), is shown as text: a
 * message has no base URL, so a relative reference resolves against nothing the
 * author controls (lost-conn/ofscp#31).
 *
 * The destination is normalized exactly as the WHATWG URL parser does before
 * the check (https://url.spec.whatwg.org/#concept-basic-url-parser): leading
 * and trailing C0 controls and spaces are trimmed, and ASCII tab and newline
 * (U+0009, U+000A, U+000D) are removed wherever they occur. Nothing else is
 * removed. That closes the scheme-check bypass (`\tjavascript:` and
 * `java\nscript:` navigate as `javascript:`) without inventing a URL the author
 * did not write: any other control character or a space inside the destination
 * stays where it is (`java\u0001script:` has no scheme at all).
 *
 * An `http`/`https`/`mailto` destination must then parse as a URL, and the link
 * carries its serialization, so what was validated is exactly what a browser
 * navigates to. An `http`/`https` URL with credentials (userinfo) stays
 * inactive: in `https://good.com @evil.com` the text before the `@` reads as
 * the destination, while the URL's host is `evil.com`.
 */

/** Where an allowed link points. */
export type LinkTarget =
  /** An `http`, `https` or `mailto` URL, as serialized by the URL parser. */
  | { readonly kind: "url"; readonly href: string }
  /** `attachment:<id>`: one of the message's own attachments (§5.3). */
  | { readonly kind: "attachment"; readonly id: string };

/** C0 control or space (U+0000 to U+0020), as the URL standard defines it. */
function isC0ControlOrSpace(code: number): boolean {
  return code <= 0x20;
}

/** ASCII tab or newline (U+0009, U+000A, U+000D), as the URL standard defines it. */
function isAsciiTabOrNewline(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * The URL parser's input normalization: trim leading and trailing C0 control
 * or space, then remove every ASCII tab or newline. By code unit rather than a
 * regex of literal control characters, which lint rules (rightly) flag.
 */
function normalizeUrlInput(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && isC0ControlOrSpace(raw.charCodeAt(start))) start++;
  while (end > start && isC0ControlOrSpace(raw.charCodeAt(end - 1))) end--;
  let out = "";
  for (let i = start; i < end; i++) {
    if (!isAsciiTabOrNewline(raw.charCodeAt(i))) out += raw[i];
  }
  return out;
}

/**
 * Parse a normalized `http`/`https`/`mailto` destination: its serialization, or
 * `null` when it does not parse or (for `http`/`https`) carries credentials.
 */
function serializedUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null; // Not a URL: a browser would not navigate to it either.
  }
  const web = url.protocol === "http:" || url.protocol === "https:";
  if (web && (url.username !== "" || url.password !== "")) return null;
  return url.href;
}

/** The scheme of an absolute URL, lower-cased, or `undefined` when it has none. */
function schemeOf(href: string): string | undefined {
  return href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
}

/**
 * Classify a link destination. Returns `null` for every link that must stay
 * inactive (shown as its text): a disallowed scheme, no scheme, a destination
 * that does not parse, an `http`/`https` URL with credentials, or an
 * `attachment:` reference with an empty id.
 */
export function linkTarget(rawHref: string): LinkTarget | null {
  const href = normalizeUrlInput(rawHref);
  const scheme = schemeOf(href);
  if (scheme === "http" || scheme === "https" || scheme === "mailto") {
    const serialized = serializedUrl(href);
    return serialized === null ? null : { kind: "url", href: serialized };
  }
  if (scheme === "attachment") {
    const id = href.slice("attachment:".length);
    return id.length > 0 ? { kind: "attachment", id } : null;
  }
  return null;
}

/**
 * The URL to load or open an attachment's file from, or `null` when it may not
 * be used. Attachment metadata is untrusted (§5.8): for an attachment its
 * provider did not check, `url` is whatever the author wrote. Only `http` and
 * `https` are ever used, so a `blob:`, `data:` or `javascript:` URL can never
 * put author-chosen bytes on the client's own origin or run as a page. It is
 * normalized and parsed as a link destination is ({@link linkTarget}).
 */
export function attachmentFileUrl(rawUrl: string): string | null {
  const url = normalizeUrlInput(rawUrl);
  const scheme = schemeOf(url);
  return scheme === "http" || scheme === "https" ? serializedUrl(url) : null;
}
