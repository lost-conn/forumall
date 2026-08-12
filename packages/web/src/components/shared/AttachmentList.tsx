/**
 * AttachmentList — one message's attachments, plus the expanded (lightbox) view
 * for them. Used by channel chat, direct messages, and the home feed; all three
 * used to hand-roll the same `<For>` + wrapper `<div>`.
 *
 * The lightbox state lives HERE, at the message level, rather than in
 * {@link AttachmentView} (which would only ever know about one attachment) or in
 * each surface (which would mean three forks and three sets of prop threading).
 * A message is exactly the scope the sibling set is defined over: prev/next page
 * through the other attachments of the SAME message and nothing else.
 */
import type { Attachment } from "@forumall/shared";
import { type Component, For, Show, createMemo, createSignal } from "solid-js";
import { expandableAttachments, expandableIndexOf } from "../../lib/attachment-gallery.ts";
import { AttachmentView } from "./AttachmentView.tsx";
import { MediaLightbox } from "./MediaLightbox.tsx";

export const AttachmentList: Component<{
  attachments: Attachment[];
  /** Testid for the wrapper row (surfaces use different ones; the feed uses none). */
  testid?: string;
}> = (props) => {
  // The lightbox slide list: images + video only, so an arrow can never land on
  // an audio track or a 📎 file that has nothing to show expanded.
  const expandable = createMemo(() => expandableAttachments(props.attachments));
  const [openIndex, setOpenIndex] = createSignal<number | null>(null);

  return (
    <div class="flex flex-wrap gap-2" data-testid={props.testid}>
      <For each={props.attachments}>
        {(att) => {
          const index = createMemo(() => expandableIndexOf(props.attachments, att));
          return (
            <AttachmentView
              attachment={att}
              onExpand={index() < 0 ? undefined : () => setOpenIndex(index())}
            />
          );
        }}
      </For>
      <Show when={openIndex() !== null}>
        <MediaLightbox
          items={expandable()}
          index={openIndex() ?? 0}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      </Show>
    </div>
  );
};
