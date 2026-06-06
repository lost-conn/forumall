/**
 * Minimal, dependency-free, XSS-safe markdown → HTML renderer (P8).
 *
 * `article`-type messages (§5.3) render as markdown; `message`/`memo` render as
 * plain text. Rather than pull in a heavyweight library we ship a small renderer
 * that covers the common subset (headings, bold/italic/code, links, lists,
 * blockquotes, fenced code, paragraphs) and is safe by construction:
 *
 *  - ALL input is HTML-escaped FIRST, so no source character can ever introduce
 *    a live tag — the only tags in the output are the ones this renderer emits.
 *  - Link `href`s are sanitized to an allowlist of safe schemes
 *    (`http`/`https`/`mailto`); anything else (notably `javascript:`) collapses
 *    to plain text, so a crafted link cannot run script.
 *
 * The output is a trusted HTML string built solely from escaped text + a fixed
 * tag vocabulary, suitable for `innerHTML`. Kept intentionally small; swap for
 * `marked`+`DOMPurify` later if richer markdown is needed.
 */

/** HTML-escape every metacharacter so source text can never become markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Allow only safe link schemes; everything else is rejected (→ plain text). */
function safeHref(rawHref: string): string | null {
  const href = rawHref.trim();
  // Relative links and fragments are safe.
  if (/^(#|\/|\.\/|\.\.\/)/.test(href)) return href;
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme === undefined) return href; // bare path, no scheme → safe
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? href : null;
}

/** Inline spans: code, bold, italic, links. Operates on already-escaped text. */
function renderInline(escaped: string): string {
  let out = escaped;
  // Inline code first (its contents are literal — re-escaping is a no-op since
  // the whole string is already escaped).
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // Links: [text](href). `href` was escaped, so unescape `&amp;` etc. before
  // scheme-checking, then re-escape for the attribute.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, rawHref: string) => {
    const unescaped = rawHref.replace(/&amp;/g, "&");
    const href = safeHref(unescaped);
    if (href === null) return label; // unsafe scheme → render the label as text
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // Bold then italic (bold first so `**x**` doesn't get eaten by the italic rule).
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<strong>${t}</strong>`);
  out = out.replace(/\*([^*]+)\*/g, (_m, t) => `<em>${t}</em>`);
  out = out.replace(/_([^_]+)_/g, (_m, t) => `<em>${t}</em>`);
  return out;
}

/**
 * Render a markdown string to a trusted, sanitized HTML string. Block grammar is
 * line-based: fenced code, headings, blockquotes, unordered/ordered lists, and
 * paragraphs (blank-line separated). Unknown constructs fall through to escaped
 * paragraph text — never raw HTML.
 */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = renderInline(escapeHtml(paragraph.join(" ")));
    blocks.push(`<p>${text}</p>`);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block: ```…```
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // consume the closing fence (if present)
      blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Blank line → paragraph boundary.
    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    // ATX heading: #..###### text
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = (heading[1] as string).length;
      blocks.push(
        `<h${level}>${renderInline(escapeHtml((heading[2] as string).trim()))}</h${level}>`,
      );
      i += 1;
      continue;
    }

    // Blockquote: > text (consecutive lines)
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${renderInline(escapeHtml(quote.join(" ")))}</blockquote>`);
      continue;
    }

    // Unordered list: -, *, + (consecutive items)
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        const item = (lines[i] ?? "").replace(/^\s*[-*+]\s+/, "");
        items.push(`<li>${renderInline(escapeHtml(item))}</li>`);
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list: 1. text (consecutive items)
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        const item = (lines[i] ?? "").replace(/^\s*\d+\.\s+/, "");
        items.push(`<li>${renderInline(escapeHtml(item))}</li>`);
        i += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Otherwise accumulate into the current paragraph.
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();

  return blocks.join("\n");
}
