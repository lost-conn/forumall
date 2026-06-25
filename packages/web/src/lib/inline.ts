/**
 * Minimal, dependency-free INLINE formatter for chat messages and DMs.
 *
 * Unlike {@link ../lib/markdown.ts `renderMarkdown`} (which emits a full block
 * grammar as an `innerHTML` string and is used for `article` bodies), this parses
 * a single message body into an inline NODE TREE that the UI renders as real Solid
 * elements. Two reasons it is separate:
 *
 *  - chat/DM bodies want only inline marks (bold, italic, code, links) — never
 *    headings/lists/code-fences, which would mangle a one-line message;
 *  - `@mentions` must stay clickable, so the body is rendered as components, not
 *    an HTML string. Mentions are spliced in via {@link parseMentionSegments} so
 *    the match rule stays byte-identical to the server's notification parser.
 *
 * Safe by construction: nodes carry only plain text + a fixed tag vocabulary, and
 * the renderer interpolates text (Solid auto-escapes) — nothing uses `innerHTML`.
 * Link `href`s pass through the shared {@link safeHref} allowlist; an unsafe scheme
 * collapses the link to its plain label, exactly as `renderMarkdown` does.
 */
import { safeHref } from "./markdown.ts";
import { parseMentionSegments } from "./mentions.ts";

/** A run of plain text. */
export interface InlineText {
  readonly type: "text";
  readonly value: string;
}
/** Bold (`**…**`). */
export interface InlineStrong {
  readonly type: "strong";
  readonly children: InlineNode[];
}
/** Italic (`*…*` or `_…_`). */
export interface InlineEm {
  readonly type: "em";
  readonly children: InlineNode[];
}
/** Inline code (`` `…` ``) — literal contents, never recursed. */
export interface InlineCode {
  readonly type: "code";
  readonly value: string;
}
/** A safe-scheme link (`[label](href)`). */
export interface InlineLink {
  readonly type: "link";
  readonly href: string;
  readonly children: InlineNode[];
}
/** A clickable `@mention` (resolved canonical `handle@domain`). */
export interface InlineMention {
  readonly type: "mention";
  readonly raw: string;
  readonly actor: string;
}

export type InlineNode =
  | InlineText
  | InlineStrong
  | InlineEm
  | InlineCode
  | InlineLink
  | InlineMention;

/**
 * One pass over the supported inline marks. Alternation order encodes precedence:
 * code → link → bold → italic(`*`) → italic(`_`). Because `matchAll` finds the
 * leftmost match and the engine tries alternatives in order at a given index,
 * `**x**` is claimed by the bold rule before the italic rule can see it. Mark
 * bodies are `[^…]+` (mirroring `renderMarkdown`'s inline rules), so a mark never
 * swallows its own delimiter; nesting of *other* marks happens via recursion.
 */
const INLINE_RE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;

/** Turn a plain run into text + mention nodes (mentions stay clickable). */
function mentionNodes(text: string, localDomain: string): InlineNode[] {
  return parseMentionSegments(text, localDomain).map((seg) =>
    seg.type === "text"
      ? { type: "text", value: seg.value }
      : { type: "mention", raw: seg.raw, actor: seg.actor },
  );
}

/**
 * Parse an inline message body into a node tree. Plain runs flow through mention
 * parsing; marks recurse so e.g. `**@alice**` is a strong wrapping a mention and
 * `_a `b` c_` is an em wrapping text + code. Unsafe link schemes degrade to the
 * (still-formatted) label.
 */
export function parseInline(text: string, localDomain: string): InlineNode[] {
  const out: InlineNode[] = [];
  let last = 0;
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push(...mentionNodes(text.slice(last, start), localDomain));

    const [, code, linkLabel, linkHref, bold, emStar, emUnder] = m;
    if (code !== undefined) {
      out.push({ type: "code", value: code });
    } else if (linkLabel !== undefined && linkHref !== undefined) {
      const href = safeHref(linkHref);
      const children = parseInline(linkLabel, localDomain);
      // Unsafe scheme → drop the link, keep the (formatted) label inline.
      if (href === null) out.push(...children);
      else out.push({ type: "link", href, children });
    } else if (bold !== undefined) {
      out.push({ type: "strong", children: parseInline(bold, localDomain) });
    } else {
      const inner = emStar ?? emUnder ?? "";
      out.push({ type: "em", children: parseInline(inner, localDomain) });
    }
    last = start + m[0].length;
  }
  if (last < text.length) out.push(...mentionNodes(text.slice(last), localDomain));
  return out;
}
