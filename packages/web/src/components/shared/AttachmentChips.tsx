/**
 * AttachmentChips — the row of pending-upload chips shown above the composer
 * input (each a 📎 filename with a remove ✕). Identical in the channel composer
 * (ChatView) and the DM composer (DmsPage); only the container testid differs.
 * Renders nothing when there are no attachments.
 */
import type { Attachment } from "@forumall/shared";
import { type Component, For, Show } from "solid-js";

export const AttachmentChips: Component<{
  attachments: Attachment[];
  onRemove: (index: number) => void;
  testid?: string;
}> = (props) => (
  <Show when={props.attachments.length > 0}>
    <div class="mb-2 flex flex-wrap gap-2" data-testid={props.testid}>
      <For each={props.attachments}>
        {(att, idx) => (
          <span class="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">
            📎 {att.filename ?? att.id}
            <button
              type="button"
              class="text-faint hover:text-danger"
              aria-label="Remove attachment"
              onClick={() => props.onRemove(idx())}
            >
              ✕
            </button>
          </span>
        )}
      </For>
    </div>
  </Show>
);
