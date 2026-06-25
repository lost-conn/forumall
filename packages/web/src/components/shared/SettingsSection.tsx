/**
 * SettingsSection — the `card` panel wrapper used across every settings screen:
 * a title (canonical `text-sm font-semibold tracking-tight`), an optional muted
 * description, then the panel body. Standardizes the heading style that had
 * drifted between panels. Pass `class` for section-level layout (e.g.
 * "flex flex-col gap-4"); the header carries its own bottom spacing.
 */
import { type Component, type JSX, Show } from "solid-js";

export const SettingsSection: Component<{
  title: string;
  description?: string;
  testid?: string;
  /** Extra classes on the <section> (defaults to just `card`). */
  class?: string;
  children: JSX.Element;
}> = (props) => (
  <section class={`card${props.class ? ` ${props.class}` : ""}`} data-testid={props.testid}>
    <div class="mb-3">
      <h2 class="text-sm font-semibold tracking-tight">{props.title}</h2>
      <Show when={props.description}>
        <p class="mt-0.5 text-xs text-muted">{props.description}</p>
      </Show>
    </div>
    {props.children}
  </section>
);
