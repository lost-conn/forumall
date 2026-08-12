/**
 * MediaLightbox — the expanded, in-page view of a message's image/video
 * attachments. Opened from an inline attachment; pages through the sibling
 * attachments of that same message with prev/next (wrapping — see
 * {@link stepExpandIndex}).
 *
 * Built on the NATIVE `<dialog>` + `showModal()`, not on {@link Modal}, for two
 * reasons. Shape: Modal is a centered `card` panel with padding and a max-width,
 * the wrong shell for a contain-fit media viewport. Behaviour: Modal's Escape is
 * an `onKeyDown` on a non-focusable `div`, so it only fires once focus already
 * happens to be inside the dialog — the browser's own dialog gives us Escape,
 * the focus trap, focus restore to the element that opened it, and top-layer
 * stacking (so no z-index or `overflow:hidden` fight with the message row),
 * all without a document-level listener to leak.
 */
import type { Attachment } from "@forumall/shared";
import { type Component, Show, onCleanup, onMount } from "solid-js";
import { stepExpandIndex } from "../../lib/attachment-gallery.ts";
import { attachmentKind, resolveAttachmentUrl } from "../../lib/chat-api.ts";
import { attachmentDownloadLink } from "./AttachmentView.tsx";

/**
 * True when a key event came from something with its own arrow-key semantics —
 * a media element (arrows seek) or a text field. Paging the gallery out from
 * under a video the user just clicked into would be hostile, so arrows are left
 * alone there; Escape stays the browser's.
 */
function ownsArrowKeys(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLVideoElement ||
    target instanceof HTMLAudioElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export const MediaLightbox: Component<{
  /** The expandable slides, in render order (see `expandableAttachments`). */
  items: Attachment[];
  /** Index of the visible slide within `items`. */
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}> = (props) => {
  let dialogRef: HTMLDialogElement | undefined;
  const current = () => props.items[props.index];
  const name = () => {
    const att = current();
    return att ? (att.filename ?? att.id) : "";
  };
  const url = () => {
    const att = current();
    return att ? resolveAttachmentUrl(att.url) : "";
  };
  const step = (delta: number): void =>
    props.onIndex(stepExpandIndex(props.index, delta, props.items.length));

  onMount(() => {
    const el = dialogRef;
    if (!el) return;
    // Escape (and the ✕/backdrop paths below, which all funnel through
    // `el.close()`) surface as one `close` event, so there is a single place
    // where the owner's state is cleared.
    const onNativeClose = (): void => props.onClose();
    el.addEventListener("close", onNativeClose);
    // Backdrop dismiss. The dialog is stretched over the whole viewport, so the
    // "outside" the user clicks is not the `::backdrop` pseudo-element but the
    // dialog's own empty space: its padding ring (target === the dialog) and the
    // stage area around the media, tagged `data-lightbox-dismiss`. Anything that
    // bubbles from the media itself or a control is left alone.
    const onBackdropClick = (e: MouseEvent): void => {
      const t = e.target;
      if (t === el || (t instanceof HTMLElement && t.dataset.lightboxDismiss !== undefined)) {
        el.close();
      }
    };
    el.addEventListener("click", onBackdropClick);
    el.showModal();
    onCleanup(() => {
      // Drop the listener BEFORE closing so unmount-driven teardown does not
      // re-enter the owner's `onClose` while it is already tearing us down.
      el.removeEventListener("close", onNativeClose);
      el.removeEventListener("click", onBackdropClick);
      if (el.open) el.close();
    });
  });

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Attachment: ${name()}`}
      class="fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 bg-black/85 p-4 text-ink backdrop:bg-black/40"
      onKeyDown={(e) => {
        if (props.items.length < 2 || ownsArrowKeys(e.target)) return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          step(1);
        }
      }}
      data-testid="media-lightbox"
    >
      <div class="flex h-full flex-col gap-3" data-lightbox-dismiss>
        {/* Header: filename, position, original link, close. */}
        <div class="flex shrink-0 items-center gap-3">
          <span class="truncate text-sm" data-testid="lightbox-filename">
            {name()}
          </span>
          <Show when={props.items.length > 1}>
            <span class="eyebrow shrink-0" data-testid="lightbox-position">
              {props.index + 1} / {props.items.length}
            </span>
          </Show>
          <span class="flex-1" />
          <a
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            class="shrink-0 text-xs text-muted hover:text-ink"
            data-testid="lightbox-original"
          >
            Open original
          </a>
          <button
            type="button"
            class="shrink-0 text-faint hover:text-ink"
            onClick={() => dialogRef?.close()}
            aria-label="Close"
            data-testid="lightbox-close"
          >
            ✕
          </button>
        </div>

        {/* Stage: the current slide, contain-fit, flanked by the prev/next rails. */}
        <div class="flex min-h-0 flex-1 items-center gap-3" data-lightbox-dismiss>
          <Show when={props.items.length > 1}>
            <button
              type="button"
              class="shrink-0 rounded-md border border-border bg-surface/80 px-2 py-3 hover:bg-surface"
              onClick={() => step(-1)}
              aria-label="Previous attachment"
              data-testid="lightbox-prev"
            >
              ‹
            </button>
          </Show>
          <div
            class="flex min-h-0 min-w-0 flex-1 items-center justify-center"
            data-lightbox-dismiss
          >
            <Show when={current()} keyed>
              {(att) => (
                <Show
                  when={attachmentKind(att) === "video"}
                  fallback={
                    <img
                      src={url()}
                      alt={name()}
                      class="max-h-[85vh] max-w-full object-contain"
                      data-testid="lightbox-image"
                    />
                  }
                >
                  {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track to attach; controls + accessible name + a fallback download link are provided instead. */}
                  <video
                    controls
                    preload="metadata"
                    playsinline
                    aria-label={name()}
                    class="max-h-[85vh] max-w-full"
                    data-testid="lightbox-video"
                  >
                    <source src={url()} type={att.mime} />
                    {attachmentDownloadLink(att, url(), "attachment-fallback-link")}
                  </video>
                </Show>
              )}
            </Show>
          </div>
          <Show when={props.items.length > 1}>
            <button
              type="button"
              class="shrink-0 rounded-md border border-border bg-surface/80 px-2 py-3 hover:bg-surface"
              onClick={() => step(1)}
              aria-label="Next attachment"
              data-testid="lightbox-next"
            >
              ›
            </button>
          </Show>
        </div>
      </div>
    </dialog>
  );
};
