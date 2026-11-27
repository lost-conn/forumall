/**
 * The §5.3 link allow-list, shared by every body format.
 *
 * "Clients MUST NOT make a link active unless its scheme is `http`, `https` or
 * `mailto` (or `attachment`)." A link with any other scheme, and a link with no
 * scheme at all (`/foo`, `#x`, `//host`, `page.html`), is shown as text: a
 * message has no base URL, so a relative reference resolves against nothing the
 * author controls (lost-conn/ofscp#31).
 *
 * The destination is first stripped of ASCII whitespace and C0 controls (plus
 * DEL). That closes a scheme-check bypass: a browser removes those characters
 * while parsing a URL, so `java\u0001script:alert(1)` navigates as
 * `javascript:`. Sanitizing before the check, and returning the sanitized
 * string, means what was validated is exactly what is emitted.
 */

/** Where an allowed link points. */
export type LinkTarget =
  /** An `http`, `https` or `mailto` URL, as validated. */
  | { readonly kind: "url"; readonly href: string }
  /** `attachment:<id>`: one of the message's own attachments (§5.3). */
  | { readonly kind: "attachment"; readonly id: string };

/** Drop every character a browser strips while parsing a URL (≤ 0x20, DEL). */
function stripUrlControls(raw: string): string {
  // By code point rather than a regex of literal control characters, which lint
  // rules (rightly) flag; this reads as what it is: keep printable characters.
  return [...raw]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x20 && code !== 0x7f;
    })
    .join("");
}

/** The scheme of an absolute URL, lower-cased, or `undefined` when it has none. */
function schemeOf(href: string): string | undefined {
  return href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
}

/**
 * Classify a link destination. Returns `null` for every link that must stay
 * inactive (shown as its text): a disallowed scheme, no scheme, or an
 * `attachment:` reference with an empty id.
 */
export function linkTarget(rawHref: string): LinkTarget | null {
  const href = stripUrlControls(rawHref);
  const scheme = schemeOf(href);
  if (scheme === "http" || scheme === "https" || scheme === "mailto") {
    return { kind: "url", href };
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
 * put author-chosen bytes on the client's own origin or run as a page.
 */
export function attachmentFileUrl(rawUrl: string): string | null {
  const url = stripUrlControls(rawUrl);
  const scheme = schemeOf(url);
  return scheme === "http" || scheme === "https" ? url : null;
}
