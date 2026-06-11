/**
 * Shared, presentational attachment renderer — images inline, everything else as
 * a download link. Used by channel chat, the home feed, and direct messages.
 *
 * Pure presentation: it only resolves the attachment URL (dev/test scheme
 * rewrite) and renders; it never fetches or mutates state, so reusing it across
 * surfaces can't regress any of them.
 */
import type { Attachment } from "@forumall/shared";
import { type Component, Show } from "solid-js";
import { isImageAttachment, resolveAttachmentUrl } from "../../lib/chat-api.ts";

/** Render one attachment: images inline, everything else as a download link. */
export const AttachmentView: Component<{ attachment: Attachment }> = (props) => {
  const url = () => resolveAttachmentUrl(props.attachment.url);
  return (
    <Show
      when={isImageAttachment(props.attachment)}
      fallback={
        <a
          href={url()}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted hover:text-ink"
          data-testid="attachment-link"
        >
          📎 {props.attachment.filename ?? props.attachment.id}
        </a>
      }
    >
      <a href={url()} target="_blank" rel="noopener noreferrer" data-testid="attachment-image-link">
        <img
          src={url()}
          alt={props.attachment.filename ?? "attachment"}
          class="max-h-64 max-w-xs rounded-lg border border-border object-contain"
          data-testid="attachment-image"
        />
      </a>
    </Show>
  );
};
