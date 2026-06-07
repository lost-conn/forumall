/**
 * Appearance settings (Terminal Garden). A purely client-side card that drives
 * the `data-theme` / `data-density` / `data-accent` attributes on `<html>` via
 * the appearance store; the CSS cascade in `forumall.css` does the rest. Choices
 * persist to localStorage and are re-applied on boot (see `main.tsx`).
 */
import { type Component, For, type JSX } from "solid-js";
import {
  ACCENTS,
  type Accent,
  DENSITIES,
  type Density,
  THEMES,
  type Theme,
  appearance,
  setAccent,
  setDensity,
  setTheme,
} from "../../stores/appearance.ts";

const THEME_LABEL: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};
const DENSITY_LABEL: Record<Density, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  cozy: "Cozy",
};
const ACCENT_LABEL: Record<Accent, string> = {
  teal: "Teal",
  phosphor: "Phosphor",
  cyan: "Cyan",
  indigo: "Indigo",
};

/** A mono, hard-edged segmented control. */
function Segmented<T extends string>(props: {
  label: string;
  testid: string;
  options: readonly T[];
  value: T;
  label_of: (v: T) => string;
  onSelect: (v: T) => void;
}): JSX.Element {
  return (
    <div class="flex flex-col gap-1.5" data-testid={props.testid}>
      <span class="eyebrow">{props.label}</span>
      <div class="flex flex-wrap gap-1.5">
        <For each={props.options}>
          {(opt) => {
            const active = () => props.value === opt;
            return (
              <button
                type="button"
                data-testid={`${props.testid}-${opt}`}
                aria-pressed={active()}
                onClick={() => props.onSelect(opt)}
                class="rounded-md border-[1.5px] px-3 py-1.5 text-[11px] font-mono font-bold uppercase tracking-wide transition-colors"
                classList={{
                  "border-accent bg-accent-soft text-accent": active(),
                  "border-border-strong text-muted hover:(bg-surface-2 text-ink)": !active(),
                }}
              >
                {props.label_of(opt)}
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}

export const AppearanceSettings: Component = () => {
  return (
    <section class="card flex flex-col gap-4" data-testid="appearance-settings">
      <div>
        <h2 class="font-display text-sm font-bold tracking-tight">Appearance</h2>
        <p class="mt-0.5 text-xs text-muted">
          Theme, density, and accent. Stored on this device only.
        </p>
      </div>
      <Segmented
        label="Theme"
        testid="appearance-theme"
        options={THEMES}
        value={appearance.theme}
        label_of={(v) => THEME_LABEL[v]}
        onSelect={setTheme}
      />
      <Segmented
        label="Density"
        testid="appearance-density"
        options={DENSITIES}
        value={appearance.density}
        label_of={(v) => DENSITY_LABEL[v]}
        onSelect={setDensity}
      />
      <Segmented
        label="Accent"
        testid="appearance-accent"
        options={ACCENTS}
        value={appearance.accent}
        label_of={(v) => ACCENT_LABEL[v]}
        onSelect={setAccent}
      />
    </section>
  );
};
