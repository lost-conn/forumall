import presetWind from "@unocss/preset-wind";
import { defineConfig } from "unocss";

/**
 * Forumall design tokens. A small, intentional palette: a deep slate canvas, a
 * warm violet→cyan accent, and a single "surface" elevation step. Aim is a
 * polished, non-generic look without a heavyweight theme. Shortcuts compose the
 * tokens so screens stay terse and consistent.
 */
export default defineConfig({
  presets: [presetWind()],
  theme: {
    colors: {
      // Canvas + surfaces (deep slate, slightly blue).
      canvas: "#0b0d12",
      surface: "#12151c",
      "surface-2": "#191d27",
      border: "#262b38",
      // Text.
      ink: "#e7e9ee",
      muted: "#9aa3b2",
      faint: "#5e6678",
      // Accent ramp (violet → indigo).
      accent: "#7c6cff",
      "accent-hi": "#9a8cff",
      "accent-lo": "#5b4ddb",
      // Secondary accent (cyan) for presence/online + highlights.
      cyan: "#3fd4d0",
      danger: "#ff5d7a",
      success: "#4ade80",
    },
    fontFamily: {
      sans: "'Inter var', Inter, ui-sans-serif, system-ui, sans-serif",
      mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
    },
  },
  shortcuts: {
    // Layout primitives.
    "app-shell": "min-h-screen w-full flex bg-canvas text-ink font-sans",
    "app-nav": "w-60 shrink-0 flex flex-col gap-1 border-r border-border bg-surface px-3 py-4",
    "app-content": "flex-1 min-w-0 flex flex-col",
    // Nav items.
    "nav-link":
      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:(bg-surface-2 text-ink)",
    "nav-link-active": "bg-surface-2 text-ink shadow-[inset_0_0_0_1px_theme(colors.border)]",
    // Components.
    "btn-accent":
      "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hi active:bg-accent-lo disabled:(opacity-50 cursor-not-allowed)",
    "btn-ghost":
      "inline-flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:(bg-surface-2 text-ink)",
    input:
      "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-faint outline-none transition-shadow focus:(border-accent shadow-[0_0_0_3px_theme(colors.accent-lo)/20])",
    card: "rounded-xl border border-border bg-surface p-5",
    badge:
      "inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted",
  },
});
