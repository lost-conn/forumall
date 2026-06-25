/**
 * Modal — the shared centered-dialog shell: a backdrop that closes on
 * outside-click and Escape, with a sized card panel. Previously this lived in
 * groups/ui.tsx and was hand-reforked (with drifting `bg-black/50` vs `/60`) by
 * the new-DM dialog, the user-profile card, and the group-management panel.
 *
 * The header (title + ✕) is **optional**: pass `title` for a titled dialog;
 * omit it for a borderless panel (e.g. the profile card) that supplies its own
 * layout and closes via its own controls / the backdrop / Escape.
 */
import { type Component, type JSX, Show } from "solid-js";

export const Modal: Component<{
  onClose: () => void;
  children: JSX.Element;
  /** When set, renders a header bar with the title and a ✕ close button. */
  title?: string;
  /** Panel max-width. Default "md". */
  size?: "sm" | "md" | "lg";
  /** Cap height at 80vh and scroll overflow (for long management panels). */
  scrollable?: boolean;
  testid?: string;
}> = (props) => (
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
    role="presentation"
    onClick={(e) => {
      if (e.currentTarget === e.target) props.onClose();
    }}
    onKeyDown={(e) => {
      if (e.key === "Escape") props.onClose();
    }}
  >
    <div
      class="card w-full"
      classList={{
        "max-w-sm": props.size === "sm",
        "max-w-md": !props.size || props.size === "md",
        "max-w-2xl": props.size === "lg",
        "max-h-[80vh] overflow-auto": props.scrollable,
      }}
      aria-label={props.title}
      data-testid={props.testid}
    >
      <Show when={props.title}>
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-sm font-semibold tracking-tight">{props.title}</h2>
          <button
            type="button"
            class="text-faint hover:text-ink"
            onClick={props.onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </Show>
      {props.children}
    </div>
  </div>
);
