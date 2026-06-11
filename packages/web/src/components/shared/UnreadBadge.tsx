/**
 * Unread-count badge (read/unread tracking). A small pill rendered on group
 * tiles (space rail), channel list items, and DM conversation items. Hidden when
 * `count` is 0; clamps large counts to `99+`.
 *
 * `variant: "corner"` (default) absolutely-positions the badge at the top-right
 * of a relatively-positioned parent (the space-rail avatar); `variant: "inline"`
 * sits in normal flow (channel / DM list rows).
 */
import { type Component, Show } from "solid-js";

export const UnreadBadge: Component<{
  count: number;
  variant?: "corner" | "inline";
}> = (props) => {
  const label = () => (props.count > 99 ? "99+" : String(props.count));
  return (
    <Show when={props.count > 0}>
      <span
        aria-label={`${props.count} unread`}
        data-testid="unread-badge"
        class="grid min-w-[1.1rem] place-items-center rounded-full bg-accent px-1.5 text-[0.65rem] font-bold leading-[1.1rem] text-white"
        classList={{
          "absolute -right-1 -top-1 ring-2 ring-bg": (props.variant ?? "corner") === "corner",
          "ml-auto h-[1.1rem]": props.variant === "inline",
        }}
      >
        {label()}
      </span>
    </Show>
  );
};
