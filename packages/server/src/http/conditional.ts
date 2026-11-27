/**
 * Conditional-request helpers (RFC 9110 §13).
 *
 * Only `If-None-Match` is needed: the routes that send an `ETag` (discovery
 * §3.1, attachments §5.8) answer a matching revalidation with `304`.
 */

/**
 * One `entity-tag` (RFC 9110 §8.8.3): `[W/] DQUOTE *etagc DQUOTE`, followed by
 * optional whitespace and a list comma or the end. `etagc` is `%x21 / %x23-7E /
 * obs-text`, which includes `,`, so the list cannot simply be split on commas.
 */
const ENTITY_TAG = /[ \t]*(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"[ \t]*(?:,|$)/y;

/**
 * The opaque tags of a well-formed `If-None-Match` list, or `null` when the
 * value is malformed (a recipient then has no list to compare against).
 * Empty list elements (`a, , b`) are allowed, as RFC 9110 §5.6.1 requires.
 */
function parseEntityTagList(value: string): string[] | null {
  const tags: string[] = [];
  let pos = 0;
  while (pos < value.length) {
    const rest = value.slice(pos);
    const empty = /^[ \t]*,/.exec(rest);
    if (empty) {
      pos += empty[0].length;
      continue;
    }
    if (/^[ \t]*$/.test(rest)) break;
    ENTITY_TAG.lastIndex = pos;
    const m = ENTITY_TAG.exec(value);
    if (!m) return null;
    tags.push(m[2] ?? "");
    pos = ENTITY_TAG.lastIndex;
  }
  return tags;
}

/** The opaque part of `etag` (its quoted text, without any `W/` prefix). */
function opaqueTag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

/**
 * Whether an `If-None-Match` header matches the current representation's
 * `etag`, i.e. the server should answer `304 Not Modified` to a `GET`/`HEAD`
 * (RFC 9110 §13.1.2). `*` matches any existing representation; otherwise the
 * comparison is the **weak** one the RFC prescribes for `If-None-Match`, so
 * `W/"x"` and `"x"` match each other. An absent or malformed header never
 * matches.
 */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  const tags = parseEntityTagList(header);
  if (tags === null) return false;
  const current = opaqueTag(etag);
  return tags.includes(current);
}
