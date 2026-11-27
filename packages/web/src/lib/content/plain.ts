/**
 * `text/plain` bodies (§5.3): "shown as is". No Markdown or HTML is
 * interpreted, and `text/plain` has no inline attachment references, so the
 * only structure is the `@mentions` the text names (shown as mentions, §5.3
 * *Mentions*). Line breaks and spacing are preserved by the renderer
 * (`white-space: pre-wrap`), not by markup.
 */
import { parseMentionSegments } from "../mentions.ts";
import type { BodyNode, ParsedBody } from "./nodes.ts";

/** Split a run of text into text and mention nodes. */
export function textWithMentions(value: string, localDomain: string): BodyNode[] {
  return parseMentionSegments(value, localDomain).map((seg) =>
    seg.type === "text"
      ? { kind: "text", value: seg.value }
      : { kind: "mention", raw: seg.raw, actor: seg.actor },
  );
}

/** Parse a `text/plain` body. */
export function parsePlain(text: string, localDomain: string): ParsedBody {
  return { nodes: textWithMentions(text, localDomain), referencedAttachmentIds: new Set() };
}
