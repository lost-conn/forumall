/**
 * Shared, presentational attachment renderer — images and video/audio render
 * inline, everything else as a download link. Used by channel chat, the home
 * feed, and direct messages (all three via {@link AttachmentList}).
 *
 * Pure presentation: it only resolves the attachment URL (dev/test scheme
 * rewrite) and renders; it never fetches or mutates state, so reusing it across
 * surfaces can't regress any of them. The expanded (lightbox) view is NOT owned
 * here — this component only reports "expand me" through `onExpand`, and
 * {@link AttachmentList} owns the state, because the lightbox needs the whole
 * message's sibling attachments to page through.
 */
import type { Attachment } from "@forumall/shared";
import { type Component, Match, Show, Switch } from "solid-js";
import { attachmentUrl } from "../../lib/attachment-url.ts";
import { attachmentKind } from "../../lib/chat-api.ts";

/**
 * The 📎 download affordance. Used in three roles, which carry DIFFERENT testids
 * on purpose: as the standalone rendering of a non-playable attachment
 * (`attachment-link`), and as the child fallback inside a `<video>`/`<audio>`
 * for a browser that cannot play the source (`attachment-fallback-link`), both
 * inline and inside the lightbox. They must stay distinguishable — one testid
 * for both would mean a selector counting download links also matched a hidden
 * fallback inside every player.
 *
 * It is a plain top-level link to the file's own URL: the browser opens it
 * under the attachment host's origin, where the §5.8 serving headers apply.
 * The client never fetches the bytes itself to show them (no `blob:`/`data:`
 * URL, `srcdoc` or frame), so a file can never run as a page of the client's
 * origin (§5.8, lost-conn/ofscp#31). With no usable `url` it is a plain label.
 */
export const attachmentDownloadLink = (
  attachment: Attachment,
  url: string | null,
  testid: string,
): ReturnType<Component> => (
  <Show
    when={url}
    fallback={
      <span
        class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-faint"
        data-testid="attachment-unavailable"
      >
        📎 {attachment.filename ?? attachment.id}
      </span>
    }
  >
    {(href) => (
      <a
        href={href()}
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted hover:text-ink"
        data-testid={testid}
      >
        📎 {attachment.filename ?? attachment.id}
      </a>
    )}
  </Show>
);

/**
 * Render one attachment: images/video/audio inline, everything else as a
 * download link.
 *
 * When `onExpand` is supplied the item gets a keyboard-reachable trigger that
 * opens the in-page expanded view. For an image the trigger is the image itself,
 * as a real `<button>` (not an `<a>` with a defeated default) so Enter/Space
 * work. For a video the trigger is a SEPARATE corner button: making the video
 * surface itself clickable would fight the native controls, where a click means
 * play/pause. Without `onExpand` an image falls back to the old
 * open-in-a-new-tab link, so the component still stands alone.
 *
 * Only the media kinds load inline, each in an element that cannot run the
 * file as a document (`<img>`, `<video>`, `<audio>`; an SVG in `<img>` runs no
 * script), whatever the untrusted `mime` claims (§5.8). An attachment whose
 * `url` may not be used ({@link attachmentUrl}) is a label and loads nothing.
 */
export const AttachmentView: Component<{ attachment: Attachment; onExpand?: () => void }> = (
  props,
) => {
  const url = () => attachmentUrl(props.attachment);
  const name = () => props.attachment.filename ?? props.attachment.id;
  const kind = () => (url() === null ? "file" : attachmentKind(props.attachment));

  return (
    <Switch fallback={attachmentDownloadLink(props.attachment, url(), "attachment-link")}>
      <Match when={kind() === "image"}>
        <Show
          when={props.onExpand}
          fallback={
            <a
              href={url() ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="attachment-image-link"
            >
              <img
                src={url() ?? undefined}
                alt={name()}
                class="max-h-64 max-w-xs rounded-lg border border-border object-contain"
                data-testid="attachment-image"
              />
            </a>
          }
        >
          <button
            type="button"
            class="block cursor-zoom-in rounded-lg focus:(outline outline-2 outline-accent outline-offset-1)"
            onClick={() => props.onExpand?.()}
            aria-label={`Expand ${name()}`}
            data-testid="attachment-image-button"
          >
            <img
              src={url() ?? undefined}
              alt={name()}
              class="max-h-64 max-w-xs rounded-lg border border-border object-contain"
              data-testid="attachment-image"
            />
          </button>
        </Show>
      </Match>
      <Match when={kind() === "video"}>
        <div class="relative inline-block">
          {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track to attach; controls + accessible name + a fallback download link are provided instead. */}
          <video
            controls
            preload="metadata"
            playsinline
            aria-label={name()}
            class="max-h-64 max-w-xs rounded-lg border border-border"
            data-testid="attachment-video"
          >
            <source src={url() ?? undefined} type={props.attachment.mime} />
            {attachmentDownloadLink(props.attachment, url(), "attachment-fallback-link")}
          </video>
          <Show when={props.onExpand}>
            <button
              type="button"
              class="absolute right-1 top-1 rounded-md border border-border bg-surface/80 px-1.5 py-0.5 text-xs text-muted hover:text-ink focus:(outline outline-2 outline-accent outline-offset-1)"
              onClick={() => props.onExpand?.()}
              aria-label={`Expand ${name()}`}
              data-testid="attachment-video-expand"
            >
              ⤢
            </button>
          </Show>
        </div>
      </Match>
      <Match when={kind() === "audio"}>
        {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track to attach; controls + accessible name + a fallback download link are provided instead. */}
        <audio controls preload="metadata" aria-label={name()} data-testid="attachment-audio">
          <source src={url() ?? undefined} type={props.attachment.mime} />
          {attachmentDownloadLink(props.attachment, url(), "attachment-fallback-link")}
        </audio>
      </Match>
    </Switch>
  );
};
