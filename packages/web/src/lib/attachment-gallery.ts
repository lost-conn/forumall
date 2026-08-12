/**
 * Attachment gallery selection + navigation — the pure logic behind the
 * in-page expanded media view (the lightbox).
 *
 * Kept out of the components on purpose: which attachments can be expanded, and
 * which one prev/next lands on, are the only parts of the feature with real
 * decisions in them, and the web test suite is logic-only (no DOM harness), so
 * this is the layer the unit tests can actually pin.
 *
 * Rendering kind comes from {@link attachmentKind} — the single source of truth
 * — so a mime that renders as an `<audio>` or a 📎 link can never end up as a
 * lightbox slide with nothing to show.
 */
import type { Attachment } from "@forumall/shared";
import { attachmentKind } from "./chat-api.ts";

/**
 * True when an attachment has something worth showing full-size: images and
 * video. Audio is deliberately excluded — an expanded audio track is just the
 * same player on a black backdrop — as are non-playable files, which only have
 * a download link.
 */
export function isExpandableAttachment(att: Attachment): boolean {
  const kind = attachmentKind(att);
  return kind === "image" || kind === "video";
}

/**
 * The expandable subset of one message's attachments, in render order. This is
 * the lightbox's slide list: audio/file items are skipped entirely, so prev/next
 * can never land on one.
 */
export function expandableAttachments(attachments: readonly Attachment[]): Attachment[] {
  return attachments.filter(isExpandableAttachment);
}

/**
 * Index of `att` within the expandable subset of `attachments`, or `-1` when it
 * is not expandable. This is the mapping from "the attachment the user clicked"
 * to "the slide to open", and it is why the inline list and the lightbox agree
 * on position without threading indices through the render.
 *
 * Matching is by attachment id (falling back to identity), so a re-fetched
 * message object with fresh attachment objects still resolves.
 */
export function expandableIndexOf(attachments: readonly Attachment[], att: Attachment): number {
  return expandableAttachments(attachments).findIndex((x) => x === att || x.id === att.id);
}

/**
 * Step the current slide by `delta`, WRAPPING at both ends (next from the last
 * item returns to the first, prev from the first goes to the last). Wrap rather
 * than clamp: these galleries are a handful of items attached to one message, so
 * a dead-ended arrow reads as broken far more often than a cycle surprises
 * anyone. Returns `0` for an empty list.
 */
export function stepExpandIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
