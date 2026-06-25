/**
 * EmptyState — the muted "nothing here yet" line shown when a list/timeline has
 * no items. Standardizes the bare `text-sm text-muted` paragraph that recurred
 * across the chat/DM/feed/contacts/requests views so the empty-state styling
 * lives in one place. `message` is JSX so callers can embed links or
 * conditional text; `class` allows per-site spacing (e.g. "px-2").
 *
 * Intentionally minimal: deliberately distinct empties (faint per-channel hints,
 * card-wrapped states, ones with a call-to-action button) keep their own markup.
 */
import type { Component, JSX } from "solid-js";

export const EmptyState: Component<{
  message: JSX.Element;
  testid?: string;
  class?: string;
}> = (props) => (
  <p class={`text-sm text-muted${props.class ? ` ${props.class}` : ""}`} data-testid={props.testid}>
    {props.message}
  </p>
);
