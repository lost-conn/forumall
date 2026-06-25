/**
 * ReplyContextPill — the "Replying to {name} ✕" chip shown above the composer
 * while a reply is in progress. Identical in the channel composer (ChatView) and
 * the DM composer (DmsPage); they differ only in how the name is resolved
 * (`displayNameForInGroup` vs `displayNameFor`) and the testid prefix.
 */
import type { Component, JSX } from "solid-js";

export const ReplyContextPill: Component<{
  /** Pre-resolved display name of the author being replied to. */
  name: JSX.Element;
  onCancel: () => void;
  /** Prepended to the pill/cancel testids, e.g. "dm-". Default "". */
  testidPrefix?: string;
}> = (props) => {
  const tid = (suffix: string): string => `${props.testidPrefix ?? ""}${suffix}`;
  return (
    <div
      class="mb-2 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-xs"
      data-testid={tid("composer-reply-pill")}
    >
      <span class="truncate text-muted">
        Replying to <span class="text-ink">{props.name}</span>
      </span>
      <button
        type="button"
        class="ml-auto text-faint hover:text-danger"
        aria-label="Cancel reply"
        data-testid={tid("cancel-reply")}
        onClick={props.onCancel}
      >
        ✕
      </button>
    </div>
  );
};
