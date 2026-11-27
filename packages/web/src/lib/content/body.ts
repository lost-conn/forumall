/**
 * Message body presentation rules (§5.3), independent of the UI:
 *
 * - {@link parseBody} dispatches on `content.mime` (never on the message type):
 *   `text/markdown` → CommonMark, `text/html` → the allow-list sanitizer, and
 *   `text/plain` or any mime this client does not support → shown as text.
 * - {@link articleView} applies the article title rule.
 * - {@link attachmentLayout} decides which attachments show where: an
 *   article's `cover`, and the attachments the body does not reference, after
 *   the body in `attachments` order.
 */
import type { Attachment } from "@forumall/shared";
import { parseHtml } from "./html.ts";
import { parseMarkdown } from "./markdown.ts";
import { type BodyNode, type ParsedBody, leadingH1, plainTextOf } from "./nodes.ts";
import { parsePlain } from "./plain.ts";

/**
 * The mime this client's composers write: their text is CommonMark, so it is
 * sent as `text/markdown` and rendered back as Markdown (§5.3).
 */
export const COMPOSED_MIME = "text/markdown";

/** How a body is interpreted. */
export type BodyFormat = "plain" | "markdown" | "html";

/** The format for a `content.mime` (parameters such as `; charset=` ignored). */
export function bodyFormat(mime: string | undefined): BodyFormat {
  const type = (mime ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type === "text/markdown") return "markdown";
  if (type === "text/html") return "html";
  // `text/plain`, and (§5.3) any body whose mime the client does not support.
  return "plain";
}

/** A parsed body plus the format it was parsed as. */
export interface Body extends ParsedBody {
  readonly format: BodyFormat;
}

/** Parse a message body by its `mime`. */
export function parseBody(content: { mime?: string; text?: string }, localDomain: string): Body {
  const text = content.text ?? "";
  const format = bodyFormat(content.mime);
  const parsed =
    format === "markdown"
      ? parseMarkdown(text, localDomain)
      : format === "html"
        ? parseHtml(text, localDomain)
        : parsePlain(text, localDomain);
  return { ...parsed, format };
}

/** An article's title and the body nodes to show under it. */
export interface ArticleView {
  /** The title, or `null` when the article is untitled. */
  readonly title: string | null;
  /** The body to show below the title. */
  readonly nodes: BodyNode[];
}

/**
 * The §5.3 article title rule. A present `title` field is the title; when it
 * is empty or whitespace the article is shown untitled (the body fallback is
 * only for an ABSENT `title`, and the body's heading stays in the body). Without
 * a `title`, the title is the body's first block when that block is a level-1
 * heading (ATX, Setext or `<h1>`); a level-1 heading anywhere else is not a
 * title. The renderer hides that heading from the body it shows below the title
 * (the spec allows it, "a renderer MAY hide it"). Otherwise the article is
 * untitled.
 */
export function articleView(message: { title?: string }, body: ParsedBody): ArticleView {
  if (typeof message.title === "string") {
    const title = message.title.trim().length > 0 ? message.title : null;
    return { title, nodes: body.nodes };
  }
  const lead = leadingH1(body.nodes);
  if (lead === null) return { title: null, nodes: body.nodes };
  const title = plainTextOf(lead.heading.children).replace(/\s+/g, " ").trim();
  return title.length > 0 ? { title, nodes: lead.rest } : { title: null, nodes: body.nodes };
}

/**
 * A one-glance plain-text description for an article card: its `summary`
 * field when present (even blank: §5.3 derives one only when `summary` is
 * absent), or else (§5.3 MAY) the shown body as plain text, whitespace
 * collapsed.
 */
export function articleSummary(message: { summary?: string }, view: ArticleView): string {
  if (typeof message.summary === "string") return message.summary;
  return plainTextOf(view.nodes).replace(/\s+/g, " ").trim();
}

/** Where a message's attachments are shown. */
export interface AttachmentLayout {
  /** An article's cover attachment, when `cover` names one of its attachments. */
  readonly cover: Attachment | undefined;
  /** Attachments shown after the body, in `attachments` order. */
  readonly trailing: Attachment[];
}

/**
 * Lay out a message's attachments (§5.3 *Inline attachments*, *Article
 * fields*): those the body references through `attachment:` are shown where
 * the body places them and not repeated; an article's `cover` is shown as its
 * cover; the rest follow the body in `attachments` order.
 */
export function attachmentLayout(
  message: { type?: string; attachments?: Attachment[]; cover?: string },
  referenced: ReadonlySet<string>,
): AttachmentLayout {
  const attachments = message.attachments ?? [];
  const coverId = message.type === "article" ? message.cover : undefined;
  const cover = coverId === undefined ? undefined : attachments.find((a) => a.id === coverId);
  const trailing = attachments.filter((a) => !referenced.has(a.id) && a.id !== cover?.id);
  return { cover, trailing };
}
