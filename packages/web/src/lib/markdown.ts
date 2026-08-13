/**
 * Minimal, dependency-free, XSS-safe markdown → HTML renderer (P8).
 *
 * `article`-type messages (§5.3) render as markdown; `message`/`memo` render as
 * plain text. Rather than pull in a heavyweight library we ship a small renderer
 * that covers the common subset (headings, bold/italic/code, links, lists,
 * blockquotes, fenced code, paragraphs) and is safe by construction:
 *
 *  - EVERY piece of source text is HTML-escaped before it reaches the output, so
 *    no source character can ever introduce a live tag — the only tags in the
 *    output are the ones this renderer emits from its own fixed vocabulary.
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

/**
 * Allow only safe link schemes; everything else is rejected (→ plain text).
 *
 * Exported because the inline formatter for chat/DM bodies (`lib/inline.ts`)
 * runs its links through the SAME allowlist — there must be exactly one answer
 * to "is this href safe", on every surface.
 *
 * The destination is first stripped of ASCII whitespace and C0 controls (plus
 * DEL). That is not cosmetic — it closes a scheme-check BYPASS: a browser
 * removes those characters while parsing a URL, so a destination written as
 * `java\u0001script:alert(1)` navigates as `javascript:alert(1)`, while a naive
 * scheme match sees a string starting `java…` that no longer looks like a
 * scheme at all and waves it through as a relative path. Sanitizing BEFORE the
 * check — and returning the sanitized string, so what we validated is exactly
 * what we emit — makes the check see what the browser will see.
 */
export function safeHref(rawHref: string): string | null {
  // Dropped by code point rather than by regex: a character class of literal
  // control characters is exactly what lint rules (rightly) flag, and this reads
  // as what it is — "keep only printable characters". This also subsumes the
  // trim this function used to do, since every character it would strip is
  // below 0x21.
  const href = [...rawHref]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x20 && code !== 0x7f;
    })
    .join("");
  // Relative links and fragments are safe.
  if (/^(#|\/|\.\/|\.\.\/)/.test(href)) return href;
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme === undefined) return href; // bare path, no scheme → safe
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? href : null;
}

/* ---------------------------------------------------------------------------
 * Inline rendering: a single-pass tokenizer.
 *
 * This used to be a cascade of `String.replace` calls over the whole (escaped)
 * string. That shape is broken by construction: every rule re-scans the HTML the
 * previous rules just emitted, so emphasis leaked into code spans and — worse —
 * into generated `href` attributes (`https://a.com/a_b_c` became
 * `https://a.com/a<em>b</em>c`). It also could not express CommonMark's
 * delimiter rules (intraword `_`, whitespace-flanked runs, unmatched runs).
 *
 * So inline parsing is now a proper scan → node tree → emit pipeline:
 *
 *   tokenizeInline()  raw source  → flat node list (text / code / link /
 *                                  unresolved emphasis delimiter runs)
 *   processEmphasis() flat list   → tree (delimiter runs matched into
 *                                  <em>/<strong>; leftovers stay literal)
 *   emitInline()      tree        → HTML, escaping every text run as it goes
 *
 * WHY THIS IS SAFE (and why there is no sentinel/placeholder scheme):
 * the emphasis pass never sees a string of HTML — it operates on *nodes*, and a
 * `code` node's body and a `link` node's `href` are opaque payloads it cannot
 * reach into. There is therefore no placeholder token for a user to forge and
 * no restore step to confuse: unforgeability is structural rather than relying
 * on picking characters the input "can't" contain. Emphasis *inside* a link
 * label still works (correct CommonMark) because the label is re-tokenized into
 * child nodes; only the `href` is inert.
 *
 * Escaping happens at emit time, once per text run, so the guarantee "no source
 * character reaches the output unescaped" holds while the parser still gets to
 * see the real characters (needed for backslash escapes and flanking rules).
 * ------------------------------------------------------------------------ */

/** A parsed inline node. `delim` is an unresolved emphasis run (may stay literal). */
type InlineNode =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; children: InlineNode[] }
  | { kind: "emph"; strong: boolean; children: InlineNode[] }
  | {
      kind: "delim";
      char: string;
      count: number;
      run: number;
      canOpen: boolean;
      canClose: boolean;
    };

type DelimNode = Extract<InlineNode, { kind: "delim" }>;

/** CommonMark "ASCII punctuation" — the set `\` may escape, and the set the
 *  flanking rules treat as punctuation. */
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

const isPunctuation = (ch: string): boolean => ch !== "" && ASCII_PUNCTUATION.includes(ch);
/** Start/end of input counts as whitespace, per CommonMark's flanking rules. */
const isWhitespace = (ch: string): boolean => ch === "" || /\s/.test(ch);

/** Link labels are re-tokenized; cap the recursion so pathological nesting
 *  (`[[[[…](x)](x)](x)`) can't blow the stack. Beyond the cap `[` is literal. */
const MAX_LINK_DEPTH = 6;

/** Index of the next backtick run of exactly `n` backticks at or after `from`. */
function findBacktickRun(src: string, from: number, n: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] !== "`") {
      i += 1;
      continue;
    }
    let end = i;
    while (src[end] === "`") end += 1;
    if (end - i === n) return i;
    i = end;
  }
  return -1;
}

/** CommonMark strips one leading + trailing space from a code span when both are
 *  present and the content isn't all spaces (so `` ` `x` `` renders as "`x`"). */
function stripCodeSpanPadding(code: string): string {
  if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") {
    return code.slice(1, -1);
  }
  return code;
}

/** Try to match `[label](href)` starting at `start` (which must be a `[`). */
function matchLink(
  src: string,
  start: number,
): { label: string; href: string; end: number } | null {
  // Find the `]` that closes the label, allowing balanced nested brackets and
  // backslash-escaped ones.
  let i = start + 1;
  let depth = 0;
  let labelEnd = -1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      if (depth === 0) {
        labelEnd = i;
        break;
      }
      depth -= 1;
    }
    i += 1;
  }
  if (labelEnd === -1 || labelEnd === start + 1) return null; // no `]`, or empty label
  if (src[labelEnd + 1] !== "(") return null;
  // Destination: everything up to the `)`. No whitespace and no titles (matching
  // the previous renderer's `[^)\s]+`); a space means "not a link".
  let j = labelEnd + 2;
  while (j < src.length) {
    const ch = src[j] as string;
    if (ch === ")") break;
    if (/\s/.test(ch)) return null;
    j += 1;
  }
  if (src[j] !== ")") return null;
  const href = src.slice(labelEnd + 2, j);
  if (href === "") return null;
  return { label: src.slice(start + 1, labelEnd), href, end: j + 1 };
}

/**
 * Scan raw (UNescaped) markdown into a flat node list. Text is accumulated
 * verbatim and only escaped in `emitInline`; code bodies and link destinations
 * are captured as opaque payloads that later passes never re-parse.
 */
function tokenizeInline(src: string, depth: number): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  const flushText = (): void => {
    if (text !== "") {
      nodes.push({ kind: "text", value: text });
      text = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;

    // Backslash escape: `\*`, `\_`, `` \` ``, `\[`, `\]`, `\\`, … — the escaped
    // character becomes literal text and the backslash is dropped, so it can
    // never start a construct. Checked first, ahead of every other rule.
    if (ch === "\\") {
      const next = src[i + 1];
      if (next !== undefined && isPunctuation(next)) {
        text += next;
        i += 2;
        continue;
      }
    }

    // Inline code: a run of N backticks closed by the next run of exactly N.
    // Its body is literal (backslashes do NOT escape inside a code span) and is
    // stored opaquely, which is what stops emphasis leaking into it.
    if (ch === "`") {
      let n = 0;
      while (src[i + n] === "`") n += 1;
      const close = findBacktickRun(src, i + n, n);
      if (close === -1) {
        text += "`".repeat(n); // unmatched opener → literal backticks
        i += n;
        continue;
      }
      flushText();
      nodes.push({ kind: "code", value: stripCodeSpanPadding(src.slice(i + n, close)) });
      i = close + n;
      continue;
    }

    // Link: [label](href). The label is re-tokenized (emphasis inside a label is
    // correct CommonMark); the destination is stored opaquely and only ever
    // scheme-checked + attribute-escaped, never re-parsed.
    if (ch === "[" && depth < MAX_LINK_DEPTH) {
      const link = matchLink(src, i);
      if (link !== null) {
        flushText();
        const children = processEmphasis(tokenizeInline(link.label, depth + 1));
        const href = safeHref(link.href);
        // Unsafe scheme → drop the anchor, keep the rendered label as text.
        if (href === null) nodes.push(...children);
        else nodes.push({ kind: "link", href, children });
        i = link.end;
        continue;
      }
    }

    // Emphasis delimiter run: a maximal run of `*` or `_`. Whether it can open
    // and/or close is decided here, from the characters flanking the run.
    if (ch === "*" || ch === "_") {
      let n = 0;
      while (src[i + n] === ch) n += 1;
      const prev = i === 0 ? "" : (src[i - 1] as string);
      const next = src[i + n] ?? "";
      // CommonMark left/right-flanking: a run is left-flanking if it isn't
      // followed by whitespace and either isn't followed by punctuation or is
      // preceded by whitespace/punctuation (mirror image for right-flanking).
      // This is what keeps `5 * 3 * 2` literal — both runs are whitespace-
      // flanked on the relevant side, so they can neither open nor close.
      const leftFlank =
        !isWhitespace(next) && (!isPunctuation(next) || isWhitespace(prev) || isPunctuation(prev));
      const rightFlank =
        !isWhitespace(prev) && (!isPunctuation(prev) || isWhitespace(next) || isPunctuation(next));
      // `*` may open/close wherever it flanks (intraword `*` IS emphasis:
      // `a*b*c` → a<em>b</em>c). `_` additionally may not open/close inside a
      // word, which is what keeps `snake_case_name` and `file_name_here.txt`
      // literal.
      const canOpen = ch === "*" ? leftFlank : leftFlank && (!rightFlank || isPunctuation(prev));
      const canClose = ch === "*" ? rightFlank : rightFlank && (!leftFlank || isPunctuation(next));
      flushText();
      nodes.push({ kind: "delim", char: ch, count: n, run: n, canOpen, canClose });
      i += n;
      continue;
    }

    text += ch;
    i += 1;
  }
  flushText();
  return nodes;
}

/**
 * Resolve delimiter runs into `<em>`/`<strong>` nodes (CommonMark's
 * "process emphasis"): walk left to right for a closer, then back for the
 * nearest compatible opener. Each match consumes two delimiters (→ strong) when
 * both runs have two to spare, otherwise one (→ em); leftovers stay in the list
 * and are emitted as literal text. `***x***` therefore nests naturally: the
 * strong pair matches first, then the surviving single pair wraps it in `<em>`.
 */
function processEmphasis(nodes: InlineNode[]): InlineNode[] {
  let i = 0;
  while (i < nodes.length) {
    const closer = nodes[i];
    if (closer === undefined || closer.kind !== "delim" || !closer.canClose) {
      i += 1;
      continue;
    }
    let openerIdx = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      const cand = nodes[j];
      if (cand === undefined || cand.kind !== "delim") continue;
      if (cand.char !== closer.char || !cand.canOpen) continue;
      // CommonMark's "rule of three": if either run can both open and close,
      // the two ORIGINAL run lengths may not sum to a multiple of 3 unless both
      // are themselves multiples of 3. (Makes `*foo**bar*` → <em>foo**bar</em>.)
      const bothWays = closer.canOpen || cand.canClose;
      if (
        bothWays &&
        (cand.run + closer.run) % 3 === 0 &&
        !(cand.run % 3 === 0 && closer.run % 3 === 0)
      ) {
        continue;
      }
      openerIdx = j;
      break;
    }
    if (openerIdx === -1) {
      i += 1; // no opener yet — the run stays put and may still open something
      continue;
    }
    const opener = nodes[openerIdx] as DelimNode;
    const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    opener.count -= use;
    closer.count -= use;
    const emph: InlineNode = {
      kind: "emph",
      strong: use === 2,
      // Anything still unresolved between the two runs is now nested inside and
      // never revisited — it degrades to literal text, as CommonMark requires.
      children: nodes.slice(openerIdx + 1, i),
    };
    const replacement: InlineNode[] = [];
    if (opener.count > 0) replacement.push(opener);
    replacement.push(emph);
    if (closer.count > 0) replacement.push(closer);
    nodes.splice(openerIdx, i - openerIdx + 1, ...replacement);
    // Re-examine the closer if it still has delimiters left, else move past.
    i = openerIdx + replacement.length - (closer.count > 0 ? 1 : 0);
  }
  return nodes;
}

/** Serialize the node tree. This is the ONLY place text becomes output, and
 *  every text-derived string goes through `escapeHtml` on the way. */
function emitInline(nodes: InlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += escapeHtml(node.value);
        break;
      case "code":
        out += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case "delim":
        // Unmatched delimiter run → literal text (`*a`, `a_b`, `5 * 3 * 2`).
        out += escapeHtml(node.char.repeat(node.count));
        break;
      case "emph":
        out += node.strong
          ? `<strong>${emitInline(node.children)}</strong>`
          : `<em>${emitInline(node.children)}</em>`;
        break;
      case "link":
        out += `<a href="${escapeHtml(node.href)}" target="_blank" rel="noopener noreferrer">${emitInline(node.children)}</a>`;
        break;
    }
  }
  return out;
}

/** Inline spans: code, bold, italic, links. Takes RAW source text (escaping is
 *  applied per text run at emit time) and returns a trusted HTML string. */
function renderInline(source: string): string {
  return emitInline(processEmphasis(tokenizeInline(source, 0)));
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
    const text = renderInline(paragraph.join(" "));
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
      blocks.push(`<h${level}>${renderInline((heading[2] as string).trim())}</h${level}>`);
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
      blocks.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      continue;
    }

    // Unordered list: -, *, + (consecutive items)
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        const item = (lines[i] ?? "").replace(/^\s*[-*+]\s+/, "");
        items.push(`<li>${renderInline(item)}</li>`);
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
        items.push(`<li>${renderInline(item)}</li>`);
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
