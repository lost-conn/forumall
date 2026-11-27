/**
 * `text/markdown` bodies (§5.3): CommonMark, parsed by markdown-it's
 * `commonmark` preset, and turned into the {@link BodyNode} tree.
 *
 * - **Raw HTML is shown as literal text** (`html: false`): markdown-it then has
 *   no HTML block or inline HTML rules, so `<b>x</b>` is ordinary text and the
 *   renderer interpolates it. The tree has no node that could carry markup.
 * - **Soft line breaks render as hard breaks** (`breaks: true`), the renderer
 *   option CommonMark allows (spec §6.12), so a chat line typed with
 *   Shift+Enter keeps its line break.
 * - The GFM extensions (tables, strikethrough, autolink) are not enabled; their
 *   syntax shows as text, which §5.3 allows.
 * - **Links** go through the §5.3 allow-list ({@link linkTarget}); a link that
 *   is not allowed keeps its text and loses the link. `attachment:<id>` links
 *   and images become attachment nodes, resolved by the renderer against the
 *   message's own attachments.
 * - **Images the body names by URL are never loaded** (§5.3 SHOULD NOT): an
 *   `http`/`https` image becomes a {@link RemoteImageNode}, shown as a link with
 *   its alt text; any other image is its alt text.
 */
import MarkdownIt, { type Token } from "markdown-it";
import { linkTarget } from "./links.ts";
import {
  type BodyNode,
  type ElementTag,
  type ParsedBody,
  collectAttachmentRefs,
  el,
} from "./nodes.ts";
import { textWithMentions } from "./plain.ts";

const md = new MarkdownIt("commonmark", { html: false, breaks: true, linkify: false });
// markdown-it's own link check turns a rejected link into its literal source
// text. Every link is classified by the §5.3 allow-list below instead, so the
// one rule ("only http, https, mailto and attachment: are active") lives in one
// place and a rejected link shows as its text, as for every other format.
md.validateLink = () => true;

/** An open container while the flat token stream is folded into a tree. */
interface Frame {
  /** The element tag, or `link` for a link whose target is resolved on close. */
  readonly tag: ElementTag | "link";
  readonly children: BodyNode[];
  readonly href?: string;
  readonly start?: number;
}

/** Block-level `*_open` token types and the tag each opens. */
const BLOCK_OPEN: Readonly<Record<string, ElementTag>> = {
  paragraph_open: "p",
  blockquote_open: "blockquote",
  bullet_list_open: "ul",
  ordered_list_open: "ol",
  list_item_open: "li",
};

/** Inline `*_open` token types and the tag each opens. */
const INLINE_OPEN: Readonly<Record<string, ElementTag>> = {
  strong_open: "strong",
  em_open: "em",
};

/** The heading tag for a `heading_open` token (`h1`…`h6`). */
function headingTag(token: Token): ElementTag {
  const level = Number(token.tag.slice(1));
  return (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[level - 1] ?? "h6";
}

/**
 * An image's alt text: the plain text of its description, with emphasis and
 * code markup removed (as CommonMark renders `alt`).
 */
function altText(tokens: readonly Token[]): string {
  let out = "";
  for (const t of tokens) {
    if (t.type === "text" || t.type === "text_special" || t.type === "code_inline") {
      out += t.content;
    } else if (t.type === "softbreak" || t.type === "hardbreak") {
      out += " ";
    } else if (t.type === "image") {
      out += altText(t.children ?? []);
    }
  }
  return out;
}

/** Folds markdown-it tokens into {@link BodyNode}s. */
class TreeBuilder {
  private readonly stack: Frame[] = [{ tag: "p", children: [] }];
  /** Nesting depth of links: no mention buttons inside an anchor. */
  private linkDepth = 0;

  constructor(private readonly localDomain: string) {}

  get nodes(): BodyNode[] {
    return this.top().children;
  }

  private top(): Frame {
    const frame = this.stack[this.stack.length - 1];
    if (frame === undefined) throw new Error("markdown tree builder: empty stack");
    return frame;
  }

  private push(node: BodyNode): void {
    this.top().children.push(node);
  }

  private open(frame: Frame): void {
    this.stack.push(frame);
  }

  /** Close the innermost frame and add what it built to its parent. */
  private close(): void {
    const frame = this.stack.pop();
    if (frame === undefined || this.stack.length === 0) {
      throw new Error("markdown tree builder: unbalanced close");
    }
    if (frame.tag !== "link") {
      const node = el(frame.tag, frame.children);
      this.push(frame.start !== undefined ? { ...node, start: frame.start } : node);
      return;
    }
    this.linkDepth -= 1;
    const target = linkTarget(frame.href ?? "");
    if (target === null) for (const child of frame.children) this.push(child);
    else if (target.kind === "url") {
      this.push({ kind: "link", href: target.href, children: frame.children });
    } else this.push({ kind: "attachment-link", id: target.id, children: frame.children });
  }

  private text(value: string): void {
    if (value.length === 0) return;
    if (this.linkDepth > 0) this.push({ kind: "text", value });
    else for (const node of textWithMentions(value, this.localDomain)) this.push(node);
  }

  block(token: Token): void {
    const tag = BLOCK_OPEN[token.type];
    if (tag !== undefined) {
      // A tight list's paragraphs are hidden: their inline content sits in the `li`.
      if (token.hidden) return;
      const start = tag === "ol" ? Number(token.attrGet("start") ?? 1) : 1;
      this.open(
        start !== 1 && Number.isInteger(start)
          ? { tag, children: [], start }
          : { tag, children: [] },
      );
      return;
    }
    switch (token.type) {
      case "heading_open":
        this.open({ tag: headingTag(token), children: [] });
        return;
      case "inline":
        for (const child of token.children ?? []) this.inline(child);
        return;
      case "fence":
      case "code_block":
        this.push(el("pre", [el("code", [{ kind: "text", value: token.content }])]));
        return;
      case "hr":
        this.push(el("hr", []));
        return;
      default:
        if (token.nesting === -1 && !(token.hidden && token.type === "paragraph_close"))
          this.close();
    }
  }

  private inline(token: Token): void {
    const tag = INLINE_OPEN[token.type];
    if (tag !== undefined) {
      this.open({ tag, children: [] });
      return;
    }
    switch (token.type) {
      case "text":
      case "text_special":
        this.text(token.content);
        return;
      case "code_inline":
        this.push(el("code", [{ kind: "text", value: token.content }]));
        return;
      case "softbreak":
      case "hardbreak":
        this.push(el("br", []));
        return;
      case "link_open":
        this.linkDepth += 1;
        this.open({ tag: "link", children: [], href: token.attrGet("href") ?? "" });
        return;
      case "image":
        this.image(token);
        return;
      default:
        if (token.nesting === -1) this.close();
    }
  }

  private image(token: Token): void {
    const alt = altText(token.children ?? []);
    const target = linkTarget(token.attrGet("src") ?? "");
    if (target?.kind === "attachment") {
      this.push({ kind: "attachment-embed", id: target.id, caption: alt });
    } else if (target?.kind === "url" && !target.href.toLowerCase().startsWith("mailto:")) {
      this.push({ kind: "remote-image", href: target.href, alt });
    } else {
      this.text(alt);
    }
  }
}

/** Parse a `text/markdown` body. */
export function parseMarkdown(source: string, localDomain: string): ParsedBody {
  const builder = new TreeBuilder(localDomain);
  for (const token of md.parse(source, {})) builder.block(token);
  const nodes = builder.nodes;
  return { nodes, referencedAttachmentIds: collectAttachmentRefs(nodes, new Set()) };
}
