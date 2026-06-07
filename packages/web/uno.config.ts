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
    "app-shell": "h-screen w-full overflow-hidden flex bg-canvas text-ink font-sans",
    "app-nav": "w-60 shrink-0 flex flex-col gap-1 border-r border-border bg-surface px-3 py-4",
    "app-content": "flex-1 min-w-0 min-h-0 flex flex-col",

    // Nav items — mono, hard active state
    "nav-link":
      "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-mono text-muted transition-colors hover:(bg-surface-2 text-ink)",
    "nav-link-active": "bg-accent-soft text-accent shadow-[inset_0_0_0_1.5px_var(--phosphor)]",

    // Buttons — uppercase mono, 1.5px border, single hard offset shadow.
    // The signature interaction (§ "Terminal Garden"): the hard offset shadow
    // GROWS on hover (3px→4px) while the button lifts (translate -1px,-1px), then
    // COLLAPSES to 0 on :active while the button presses INTO the page
    // (translate 2px,2px). Driven on the 120ms cubic-bezier(.2,.8,.2,1) curve,
    // transitioning transform + box-shadow + background together.
    // `transition` (the default property set) already covers transform +
    // box-shadow + background-color, on the Terminal Garden 120ms cubic curve.
    "btn-base": "transition duration-[120ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]",
    "btn-accent":
      "btn-base inline-flex items-center justify-center gap-2 rounded-md border-[1.5px] border-border-strong bg-accent px-4 py-2 text-xs font-mono font-bold uppercase tracking-wide text-accent-ink shadow-[3px_3px_0_var(--on-accent-shadow-col)] hover:(-translate-x-px -translate-y-px shadow-[4px_4px_0_var(--on-accent-shadow-col)]) active:(translate-x-0.5 translate-y-0.5 shadow-[0_0_0_var(--shadow-col)]) disabled:(opacity-50 cursor-not-allowed shadow-none translate-x-0 translate-y-0)",
    // Ghost: transparent + dashed border, no shadow. Solidifies + fills on hover,
    // and still presses in slightly on :active to keep the tactile feel.
    "btn-ghost":
      "btn-base inline-flex items-center justify-center gap-2 rounded-md border-[1.5px] border-dashed border-border-strong px-4 py-2 text-xs font-mono font-bold uppercase tracking-wide text-ink hover:(bg-surface border-solid) active:(translate-x-px translate-y-px) disabled:(opacity-50 cursor-not-allowed)",

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
