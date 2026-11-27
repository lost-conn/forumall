/**
 * The render tree every message body is parsed into (§5.3), whatever its
 * `mime`. `text/plain`, `text/markdown` and `text/html` each have a parser
 * (`plain.ts`, `markdown.ts`, `html.ts`) that produces these nodes, and one
 * Solid renderer (`components/shared/BodyContent.tsx`) turns them into DOM.
 *
 * Safe by construction: an element node can only carry a tag from
 * {@link ElementTag}, the §5.3 sanitizer allow-list minus `a` and `img` (those
 * become link and attachment nodes, whose targets are already validated), and
 * the only attributes the tree can express are `colspan`/`rowspan` (numbers)
 * and an ordered list's `start` (a number). Text is text: the renderer
 * interpolates it, never `innerHTML`.
 */

/** The element tags a body may produce (§5.3 allow-list, without `a`/`img`). */
export const ELEMENT_TAGS = [
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "sub",
  "sup",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
] as const;
export type ElementTag = (typeof ELEMENT_TAGS)[number];

/** A run of text. */
export interface TextNode {
  readonly kind: "text";
  readonly value: string;
}

/** An `@mention` the text names, resolved to a canonical actor. */
export interface MentionNode {
  readonly kind: "mention";
  readonly raw: string;
  readonly actor: string;
}

/** An allow-listed element and its children. */
export interface ElementNode {
  readonly kind: "element";
  readonly tag: ElementTag;
  readonly children: BodyNode[];
  /** `th`/`td` only (HTML bodies): positive integers. */
  readonly colspan?: number;
  readonly rowspan?: number;
  /** `ol` only: the first item's number, when it is not 1. */
  readonly start?: number;
}

/** An active `http`/`https`/`mailto` link. */
export interface LinkNode {
  readonly kind: "link";
  readonly href: string;
  readonly children: BodyNode[];
}

/** A link to one of the message's own attachments (`[text](attachment:<id>)`). */
export interface AttachmentLinkNode {
  readonly kind: "attachment-link";
  readonly id: string;
  readonly children: BodyNode[];
}

/**
 * One of the message's own attachments shown at this point in the body
 * (`![caption](attachment:<id>)`, or `<img data-attachment="<id>">`).
 */
export interface AttachmentEmbedNode {
  readonly kind: "attachment-embed";
  readonly id: string;
  readonly caption: string;
}

/**
 * An image the body names by URL (`![alt](https://…)`). It is never loaded
 * automatically (§5.3: loading it tells that host who read the message and
 * when); the renderer shows it as a link with its alt text.
 */
export interface RemoteImageNode {
  readonly kind: "remote-image";
  readonly href: string;
  readonly alt: string;
}

export type BodyNode =
  | TextNode
  | MentionNode
  | ElementNode
  | LinkNode
  | AttachmentLinkNode
  | AttachmentEmbedNode
  | RemoteImageNode;

/** A parsed body: its nodes plus the attachment ids it references (§5.3). */
export interface ParsedBody {
  readonly nodes: BodyNode[];
  /** Ids named by `attachment:` references (image or link), in body order. */
  readonly referencedAttachmentIds: ReadonlySet<string>;
}

/** Build an element node (keeps the parsers terse). */
export function el(tag: ElementTag, children: BodyNode[]): ElementNode {
  return { kind: "element", tag, children };
}

/** Collect the ids every `attachment:` node in a tree references. */
export function collectAttachmentRefs(nodes: readonly BodyNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind === "attachment-link" || node.kind === "attachment-embed") into.add(node.id);
    if ("children" in node) collectAttachmentRefs(node.children, into);
  }
  return into;
}

/** True for a text node holding only whitespace (inter-block HTML whitespace). */
function isBlankText(node: BodyNode): boolean {
  return node.kind === "text" && node.value.trim().length === 0;
}

/**
 * The body's first block when it is a level-1 heading, with the nodes after
 * it; otherwise `null`. A Markdown ATX (`# T`) or Setext (`T` over `===`)
 * heading and an HTML `<h1>` all parse to an `h1` element, while a `# T` line
 * in `text/plain` (or raw HTML inside Markdown) never does, so this one check
 * implements the §5.3 article-title rule for every format.
 */
export function leadingH1(
  nodes: readonly BodyNode[],
): { heading: ElementNode; rest: BodyNode[] } | null {
  const index = nodes.findIndex((n) => !isBlankText(n));
  const first = nodes[index];
  if (first === undefined || first.kind !== "element" || first.tag !== "h1") return null;
  return { heading: first, rest: nodes.slice(index + 1) };
}

/** The text of a tree with all markup removed (mentions keep their raw `@…`). */
export function plainTextOf(nodes: readonly BodyNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.value;
        break;
      case "mention":
        out += node.raw;
        break;
      case "attachment-embed":
        out += node.caption;
        break;
      case "remote-image":
        out += node.alt;
        break;
      case "element":
        out += node.tag === "br" ? "\n" : plainTextOf(node.children);
        if (BLOCK_TAGS.has(node.tag)) out += "\n";
        break;
      default:
        out += plainTextOf(node.children);
    }
  }
  return out;
}

/** Tags that end a line when flattened to plain text. */
const BLOCK_TAGS: ReadonlySet<ElementTag> = new Set<ElementTag>([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "li",
  "tr",
  "hr",
]);
