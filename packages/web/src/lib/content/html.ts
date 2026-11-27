/**
 * `text/html` bodies (§5.3): rendered only through the §5.3 allow-list
 * sanitizer, implemented here.
 *
 * The HTML is parsed by parse5 (a pure-JS, spec-compliant HTML parser), so the
 * sanitizer sees exactly the tree a browser would build, including its error
 * recovery, without a DOM: nothing is ever given to the browser's own parser
 * (`innerHTML`, `DOMParser`), so no element is created, no resource is fetched
 * and no handler can run while sanitizing. The parsed tree is then walked into
 * {@link BodyNode}s, which by construction can only express the allow-list:
 *
 * - kept elements: `p br hr h1–h6 strong b em i u s del sub sup code pre
 *   blockquote ul ol li a img table thead tbody tr th td span`;
 * - kept attributes: `href` on `a` (then the link allow-list), `alt` and
 *   `data-attachment` on `img`, `colspan`/`rowspan` on `th`/`td`. Every other
 *   attribute (`src`, `style`, `class`, `id`, `on*`, …) is dropped;
 * - `script style iframe object embed template noscript` are removed with
 *   their contents; every other element is removed and its content kept.
 *
 * An `<img>` with `data-attachment` places that attachment (§5.3 *Inline
 * attachments*); without it there is nothing to show but its `alt` text, since
 * `src` is never kept.
 */
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5";
import { linkTarget } from "./links.ts";
import {
  type BodyNode,
  ELEMENT_TAGS,
  type ElementNode,
  type ElementTag,
  type ParsedBody,
  collectAttachmentRefs,
  el,
} from "./nodes.ts";
import { textWithMentions } from "./plain.ts";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** Elements removed together with everything inside them (§5.3). */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
]);

const KEPT_TAGS: ReadonlySet<string> = new Set<string>(ELEMENT_TAGS);

/** True when an element is kept as itself (not `a`/`img`, handled apart). */
function isKeptTag(tag: string): tag is ElementTag {
  return KEPT_TAGS.has(tag);
}

/** Elements inside which `@…` text is not turned into mention buttons. */
const NO_MENTIONS: ReadonlySet<string> = new Set(["a", "code", "pre"]);

/** The largest `colspan`/`rowspan` kept (HTML's own limits are 1000 / 65534). */
const MAX_SPAN = 1000;

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

/** A `colspan`/`rowspan` value as a positive integer, or `undefined`. */
function span(element: Element, name: "colspan" | "rowspan"): number | undefined {
  const raw = attr(element, name)?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= 1 && value <= MAX_SPAN ? value : undefined;
}

class Sanitizer {
  constructor(private readonly localDomain: string) {}

  children(nodes: readonly ChildNode[], mentions: boolean): BodyNode[] {
    return nodes.flatMap((node) => this.node(node, mentions));
  }

  private node(node: ChildNode, mentions: boolean): BodyNode[] {
    if (node.nodeName === "#text" && "value" in node) {
      if (node.value.length === 0) return [];
      return mentions
        ? textWithMentions(node.value, this.localDomain)
        : [{ kind: "text", value: node.value }];
    }
    // Comments and doctypes carry nothing to show.
    if (!("tagName" in node)) return [];
    const tag = node.tagName;
    if (DROP_WITH_CONTENT.has(tag)) return [];
    const inner = mentions && !NO_MENTIONS.has(tag);
    if (tag === "a") return this.anchor(node, inner);
    if (tag === "img") return this.image(node);
    const children = this.children(node.childNodes, inner);
    if (!isKeptTag(tag)) return children;
    return [this.element(node, tag, children)];
  }

  private element(node: Element, tag: ElementTag, children: BodyNode[]): ElementNode {
    const base = el(tag, children);
    if (tag !== "th" && tag !== "td") return base;
    const colspan = span(node, "colspan");
    const rowspan = span(node, "rowspan");
    return {
      ...base,
      ...(colspan !== undefined ? { colspan } : {}),
      ...(rowspan !== undefined ? { rowspan } : {}),
    };
  }

  private anchor(node: Element, mentions: boolean): BodyNode[] {
    const children = this.children(node.childNodes, mentions);
    const href = attr(node, "href");
    const target = href === undefined ? null : linkTarget(href);
    if (target === null) return children;
    return target.kind === "url"
      ? [{ kind: "link", href: target.href, children }]
      : [{ kind: "attachment-link", id: target.id, children }];
  }

  private image(node: Element): BodyNode[] {
    const caption = attr(node, "alt") ?? "";
    const id = attr(node, "data-attachment");
    if (id !== undefined && id.length > 0) return [{ kind: "attachment-embed", id, caption }];
    return caption.length > 0 ? [{ kind: "text", value: caption }] : [];
  }
}

/** Parse and sanitize a `text/html` body. */
export function parseHtml(source: string, localDomain: string): ParsedBody {
  const fragment = parseFragment(source);
  const nodes = new Sanitizer(localDomain).children(fragment.childNodes, true);
  return { nodes, referencedAttachmentIds: collectAttachmentRefs(nodes, new Set()) };
}
