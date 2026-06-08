/**
 * Small presentational primitives shared across the groups screens (P8): a modal
 * shell, a tier select, and an error-message helper. Themed via the UnoCSS
 * tokens so the screens stay terse + consistent with the app shell.
 */
import type { TiersResponse } from "@forumall/shared";
import { type Component, For, type JSX, Show } from "solid-js";
import { OfscpHttpError } from "../../lib/ofscp-client.ts";

/** Distill an unknown error into a user-facing message. */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof OfscpHttpError) {
    const body = err.body as { detail?: string } | undefined;
    return body?.detail ?? `Request failed (${err.status}).`;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

/** A centered modal dialog with a backdrop. */
export const Modal: Component<{
  title: string;
  onClose: () => void;
  children: JSX.Element;
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
    <div class="card w-full max-w-md" aria-label={props.title} data-testid={props.testid}>
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
      {props.children}
    </div>
  </div>
);

/** A labelled field wrapper. */
export const Field: Component<{ label: string; children: JSX.Element; hint?: string }> = (
  props,
) => (
  <div class="flex flex-col gap-1.5">
    <span class="text-xs font-medium text-muted">
      {props.label}
      <Show when={props.hint}>
        <span class="text-faint"> {props.hint}</span>
      </Show>
    </span>
    {props.children}
  </div>
);

/** A tier `<select>` populated from `GET /api/tiers`. */
export const TierSelect: Component<{
  tiers: TiersResponse | undefined;
  value: string;
  onChange: (v: string) => void;
  name?: string;
  testid?: string;
}> = (props) => (
  <select
    class="input"
    name={props.name}
    value={props.value}
    onChange={(e) => props.onChange(e.currentTarget.value)}
    data-testid={props.testid}
  >
    <Show when={props.tiers} fallback={<option value={props.value}>{props.value}</option>}>
      <For each={props.tiers?.tiers ?? []}>{(t) => <option value={t.id}>{t.name}</option>}</For>
    </Show>
  </select>
);

/** An inline error line. */
export const ErrorLine: Component<{ message: string | null; testid?: string }> = (props) => (
  <Show when={props.message}>
    <p class="text-sm text-danger" role="alert" data-testid={props.testid}>
      {props.message}
    </p>
  </Show>
);

/** A small role pill, optionally tinted with the role's catalogue color. */
export const RoleBadge: Component<{ role: string; color?: string }> = (props) => (
  <span
    class="badge inline-flex items-center gap-1 text-[10px] uppercase tracking-wide"
    data-testid="member-role"
  >
    <Show when={props.color}>
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ "background-color": props.color }}
        aria-hidden="true"
      />
    </Show>
    {props.role}
  </span>
);
