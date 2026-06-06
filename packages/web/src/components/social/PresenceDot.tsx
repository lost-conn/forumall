/**
 * Presence indicator dot (P8, §7.5). Renders a small status dot for an actor's
 * effective availability (online / away / dnd / offline) read live from the
 * presence store, with the status text exposed via `title` + an accessible label.
 *
 * It is purely presentational — it does NOT manage the WS subscription. A view
 * that renders dots subscribes the actors it shows via `subscribePresence(...)`
 * (see `presence-controller.ts`) and disposes on cleanup; the dot just reflects
 * whatever the store holds (default `offline` until a snapshot/update arrives).
 */
import { type Component, Show } from "solid-js";
import { type Availability, presence } from "../../stores/presence.ts";

/** Tailwind/UnoCSS color per availability. */
const DOT_COLOR: Record<Availability, string> = {
  online: "bg-success",
  away: "bg-amber-400",
  dnd: "bg-danger",
  offline: "bg-faint",
};

const LABEL: Record<Availability, string> = {
  online: "Online",
  away: "Away",
  dnd: "Do not disturb",
  offline: "Offline",
};

export const PresenceDot: Component<{ actor: string; size?: "sm" | "md"; showStatus?: boolean }> = (
  props,
) => {
  // Read reactively from the store so live `presence.update` re-renders the dot.
  const state = () => presence.byActor[props.actor] ?? { availability: "offline" as Availability };
  const availability = (): Availability => state().availability;
  const sizeClass = () => (props.size === "md" ? "h-2.5 w-2.5" : "h-2 w-2");

  return (
    <span class="inline-flex items-center gap-1.5">
      <span
        class={`inline-block shrink-0 rounded-full ${sizeClass()} ${DOT_COLOR[availability()]}`}
        data-testid="presence-dot"
        data-actor={props.actor}
        data-availability={availability()}
        title={
          state().status ? `${LABEL[availability()]} — ${state().status}` : LABEL[availability()]
        }
        aria-label={`${LABEL[availability()]}${state().status ? `: ${state().status}` : ""}`}
      />
      <Show when={props.showStatus && state().status}>
        <span class="truncate text-xs text-faint" data-testid="presence-status">
          {state().status}
        </span>
      </Show>
    </span>
  );
};
