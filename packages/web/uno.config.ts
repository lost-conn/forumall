import presetWind from "@unocss/preset-wind";
import { defineConfig } from "unocss";

/**
 * Forumall — "Terminal Garden" design tokens for UnoCSS.
 *
 * DROP-IN REPLACEMENT for packages/web/uno.config.ts.
 *
 * Every color resolves to a CSS variable defined in `forumall.css` (import it
 * once in src/main.tsx). That indirection is the whole trick: putting
 * [data-theme="light|dark"], [data-density="compact|comfortable|cozy"], and
 * [data-accent] on <html> retheme the entire app with zero JS and zero churn —
 * your existing `bg-surface text-ink card badge nav-link btn-accent` usages all
 * keep working and simply adopt the new look.
 *
 * Theme follows the OS and falls back to DARK when ambiguous (handled in forumall.css).
 */
export default defineConfig({
  presets: [presetWind()],
  theme: {
    colors: {
      // Canvas + surfaces
      canvas: "var(--bg)",
      surface: "var(--surface)",
      "surface-2": "var(--surface-2)",
      border: "var(--line)",
      "border-strong": "var(--line-strong)",
      // Text
      ink: "var(--ink)",
      muted: "var(--ink-2)",
      faint: "var(--ink-3)",
      // Primary cool accent (TEAL). Name kept as `accent` for drop-in compatibility;
      // the hi/lo steps collapse onto one token — depth comes from borders/shadows, not tints.
      accent: "var(--phosphor)",
      "accent-hi": "var(--phosphor)",
      "accent-lo": "var(--phosphor)",
      "accent-ink": "var(--phosphor-ink)",
      "accent-soft": "var(--phosphor-soft)",
      // Warm secondary
      ember: "var(--ember)",
      "ember-ink": "var(--ember-ink)",
      "ember-soft": "var(--ember-soft)",
      // Legacy `cyan` (presence/online) folds onto the primary accent
      cyan: "var(--phosphor)",
      danger: "var(--danger)",
      success: "var(--phosphor)",
      warn: "var(--warn)",
      // Content types (chat = neutral ink, article = ember, memo = phosphor)
      "c-chat": "var(--ink-2)",
      "c-article": "var(--ember)",
      "c-memo": "var(--phosphor)",
    },
    fontFamily: {
      display: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
      sans: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
      mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
    },
    // Hard edges: small radii
    borderRadius: {
      none: "0",
      sm: "3px",
      DEFAULT: "5px",
      md: "5px",
      lg: "8px",
      xl: "8px",
      full: "9999px",
    },
  },
  shortcuts: {
    // Layout primitives (unchanged class names → free restyle)
    "app-shell": "min-h-screen w-full flex bg-canvas text-ink font-sans",
    "app-nav": "w-60 shrink-0 flex flex-col gap-1 border-r border-border bg-surface px-3 py-4",
    "app-content": "flex-1 min-w-0 flex flex-col",

    // Nav items — mono, hard active state
    "nav-link":
      "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-mono text-muted transition-colors hover:(bg-surface-2 text-ink)",
    "nav-link-active": "bg-accent-soft text-accent shadow-[inset_0_0_0_1.5px_var(--phosphor)]",

    // Buttons — uppercase mono, 1.5px border, single hard offset shadow,
    // lift on hover and press *into* the page on :active (the signature interaction)
    "btn-accent":
      "inline-flex items-center justify-center gap-2 rounded-md border-[1.5px] border-border-strong bg-accent px-4 py-2 text-xs font-mono font-bold uppercase tracking-wide text-accent-ink shadow-[3px_3px_0_var(--shadow-col)] transition-transform hover:-translate-x-px hover:-translate-y-px active:(translate-x-0.5 translate-y-0.5 shadow-none) disabled:(opacity-50 cursor-not-allowed)",
    "btn-ghost":
      "inline-flex items-center justify-center gap-2 rounded-md border-[1.5px] border-dashed border-border-strong px-4 py-2 text-xs font-mono font-bold uppercase tracking-wide text-ink transition-colors hover:(bg-surface border-solid)",

    // Form + surfaces
    input:
      "w-full rounded-md border-[1.5px] border-border-strong bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-faint outline-none focus:(outline outline-2 outline-accent outline-offset-1)",
    card: "rounded-lg border-[1.5px] border-border-strong bg-surface p-4",
    "card-raised": "card shadow-[3px_3px_0_var(--shadow-col)]",

    // Eyebrow / label — the mono uppercase signal used everywhere
    eyebrow: "text-[11px] font-mono uppercase tracking-[0.14em] text-muted",

    // Badges + content-type tags
    badge:
      "inline-flex items-center gap-1.5 rounded-sm border-[1.5px] border-border-strong px-2 py-0.5 text-[11px] font-mono uppercase tracking-wide text-muted",
    "tag-chat": "badge",
    "tag-article": "badge border-ember text-ember bg-ember-soft",
    "tag-memo": "badge border-accent text-accent bg-accent-soft",

    // Federation / instance pill
    pill: "inline-flex items-center gap-1.5 rounded-md border-[1.5px] border-accent bg-accent-soft px-2.5 py-1 text-[11px] font-mono text-accent",
  },
});
