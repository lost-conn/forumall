/**
 * Shared, presentational reply-quote snippet — the small "↳ replying to …" line
 * shown above a message that references a parent. Used by BOTH channel chat and
 * direct messages.
 *
 * It is parameterized by the parent's *resolved* display fields rather than a
 * concrete message type + a store lookup, so it carries no surface-specific
 * coupling (channels resolve the author name per-group, DMs use the global
 * display name). When `jumpable` is true and `onJump` is provided, the snippet is
 * a button that scrolls to the parent; otherwise it renders as inert text (the
 * parent is deleted or outside the loaded window).
 */
import type { Component } from "solid-js";

export interface ReplyQuoteParent {
  /** The parent message id, for the jump callback. */
  id: string;
  /** Resolved author display name (already mapped per-surface). */
  authorName: string;
  /** The parent's text (raw); clipped + whitespace-collapsed for the snippet. */
  text?: string;
  /** True when the parent is tombstoned. */
  deleted?: boolean;
}

/** Build the "author: clipped text" snippet for a reply quote. */
function snippetFor(parent: ReplyQuoteParent | undefined): string {
  if (!parent) return "a message";
  if (parent.deleted) return "a deleted message";
  const text = (parent.text ?? "").replace(/\s+/g, " ").trim();
  const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return clipped ? `${parent.authorName}: ${clipped}` : parent.authorName;
}

export const ReplyQuote: Component<{
  parent?: ReplyQuoteParent;
  onJump?: (id: string) => void;
}> = (props) => {
  const jumpable = () => props.parent !== undefined && !props.parent.deleted;
  return (
    <button
      type="button"
      class="flex max-w-full items-center gap-1 text-left text-xs text-faint transition-colors enabled:cursor-pointer enabled:hover:text-accent disabled:cursor-default"
      data-testid="reply-quote"
      disabled={!jumpable()}
      title={jumpable() ? "Jump to the original message" : undefined}
      onClick={() => {
        const p = props.parent;
        if (p) props.onJump?.(p.id);
      }}
    >
      <span aria-hidden="true">↳</span>
      <span class="truncate">replying to {snippetFor(props.parent)}</span>
    </button>
  );
};
