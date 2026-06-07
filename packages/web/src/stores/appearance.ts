/**
 * Appearance store — drives the Terminal Garden theme/density/accent attributes
 * on `document.documentElement`. The whole cascade lives in `forumall.css`; all
 * this store does is set (or remove) the three `data-*` attributes and persist
 * the choice to localStorage so it survives reloads.
 *
 * Defaults mirror the CSS: an ABSENT `data-theme` follows the OS (dark fallback)
 * and an ABSENT `data-accent` is the locked teal default — so "system" / "teal"
 * remove their attribute rather than setting one. Density is always written
 * (every value is a real CSS branch; "comfortable" is the default).
 */
import { createStore } from "solid-js/store";

export type Theme = "system" | "light" | "dark";
export type Density = "compact" | "comfortable" | "cozy";
export type Accent = "teal" | "phosphor" | "cyan" | "indigo";

export const THEMES: Theme[] = ["system", "light", "dark"];
export const DENSITIES: Density[] = ["compact", "comfortable", "cozy"];
export const ACCENTS: Accent[] = ["teal", "phosphor", "cyan", "indigo"];

interface Appearance {
  theme: Theme;
  density: Density;
  accent: Accent;
}

const KEY = { theme: "forumall.theme", density: "forumall.density", accent: "forumall.accent" };

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

const [appearance, setAppearance] = createStore<Appearance>({
  theme: read(KEY.theme, THEMES, "system"),
  density: read(KEY.density, DENSITIES, "comfortable"),
  accent: read(KEY.accent, ACCENTS, "teal"),
});

export { appearance };

/** Reflect the current store onto `<html>`. Idempotent; safe to call on boot. */
export function applyAppearance(): void {
  const el = document.documentElement;
  // theme: "system" → no attribute (CSS follows prefers-color-scheme, dark fallback)
  if (appearance.theme === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", appearance.theme);
  // density: always explicit
  el.setAttribute("data-density", appearance.density);
  // accent: "teal" is the locked default → no attribute
  if (appearance.accent === "teal") el.removeAttribute("data-accent");
  else el.setAttribute("data-accent", appearance.accent);
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / disabled storage — in-memory only */
  }
}

export function setTheme(theme: Theme): void {
  setAppearance("theme", theme);
  persist(KEY.theme, theme);
  applyAppearance();
}

export function setDensity(density: Density): void {
  setAppearance("density", density);
  persist(KEY.density, density);
  applyAppearance();
}

export function setAccent(accent: Accent): void {
  setAppearance("accent", accent);
  persist(KEY.accent, accent);
  applyAppearance();
}
