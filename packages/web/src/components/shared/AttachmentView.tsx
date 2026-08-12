/**
 * Shared, presentational attachment renderer — images and video/audio render
 * inline, everything else as a download link. Used by channel chat, the home
 * feed, and direct messages.
 *
 * Pure presentation: it only resolves the attachment URL (dev/test scheme
 * rewrite) and renders; it never fetches or mutates state, so reusing it across
 * surfaces can't regress any of them.
 */
import type { Attachment } from "@forumall/shared";
import { type Component, Match, Switch } from "solid-js";
import { attachmentKind, resolveAttachmentUrl } from "../../lib/chat-api.ts";

/**
 * The 📎 download affordance. Used in two roles, which carry DIFFERENT testids
 * on purpose: as the standalone rendering of a non-playable attachment
 * (`attachment-link`), and as the child fallback inside a `<video>`/`<audio>`
 * for a browser that cannot play the source (`attachment-fallback-link`). They
 * must stay distinguishable — one testid for both would mean a selector
 * counting download links also matched a hidden fallback inside every player.
 */
const downloadLink = (attachment: Attachment, url: string, testid: string) => (
  <a
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted hover:text-ink"
    data-testid={testid}
  >
    📎 {attachment.filename ?? attachment.id}
  </a>
);

/** Render one attachment: images/video/audio inline, everything else as a download link. */
export const AttachmentView: Component<{ attachment: Attachment }> = (props) => {
  const url = () => resolveAttachmentUrl(props.attachment.url);
  const name = () => props.attachment.filename ?? props.attachment.id;

  return (
    <Switch fallback={downloadLink(props.attachment, url(), "attachment-link")}>
      <Match when={attachmentKind(props.attachment) === "image"}>
        <a
          href={url()}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="attachment-image-link"
        >
          <img
            src={url()}
            alt={props.attachment.filename ?? "attachment"}
            class="max-h-64 max-w-xs rounded-lg border border-border object-contain"
            data-testid="attachment-image"
          />
        </a>
      </Match>
      <Match when={attachmentKind(props.attachment) === "video"}>
        {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track to attach; controls + accessible name + a fallback download link are provided instead. */}
        <video
          controls
          preload="metadata"
          playsinline
          aria-label={name()}
          class="max-h-64 max-w-xs rounded-lg border border-border"
          data-testid="attachment-video"
        >
          <source src={url()} type={props.attachment.mime} />
          {downloadLink(props.attachment, url(), "attachment-fallback-link")}
        </video>
      </Match>
      <Match when={attachmentKind(props.attachment) === "audio"}>
        {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track to attach; controls + accessible name + a fallback download link are provided instead. */}
        <audio controls preload="metadata" aria-label={name()} data-testid="attachment-audio">
          <source src={url()} type={props.attachment.mime} />
          {downloadLink(props.attachment, url(), "attachment-fallback-link")}
        </audio>
      </Match>
    </Switch>
  );
};
