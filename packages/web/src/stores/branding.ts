/**
 * Provider-branding store (Forumall extension).
 *
 * Holds the instance's customizable branding — display `name`, `iconUrl`, and
 * `accentColor` — fetched from the PUBLIC `GET /api/provider` endpoint. The web
 * client applies it on boot (page title, favicon, accent CSS variable, header
 * brand name) and refreshes it after an admin saves (see `BrandingSettings`).
 *
 * The fetch is unauthenticated (the endpoint is public), so this works pre-login
 * and against whichever provider the page is served from.
 */
import { createSignal } from "solid-js";
import { baseUrlForHost } from "../lib/provider.ts";
import { isAdmin } from "./session.ts";

/** Who may create groups on this instance (Forumall extension). */
export type GroupCreationPolicy = "open" | "admin-only";

/** Branding as returned by `GET /api/provider`. */
export interface ProviderBranding {
  domain: string;
  name: string;
  iconUrl: string | null;
  accentColor: string | null;
  /** Who may create groups (defaults to `open` when an older server omits it). */
  groupCreationPolicy?: GroupCreationPolicy;
}

/** The default brand name when an instance hasn't set a custom one. */
export const DEFAULT_BRAND_NAME = "Forumall";

const [branding, setBranding] = createSignal<ProviderBranding | null>(null);
export { branding };

/** The current brand name, falling back to "Forumall" when unknown. */
export function brandName(): string {
  return branding()?.name ?? DEFAULT_BRAND_NAME;
}

/**
 * The current group-creation policy. Defaults to `open` until the branding is
 * loaded (or when an older server omits the field).
 */
export function groupCreationPolicy(): GroupCreationPolicy {
  return branding()?.groupCreationPolicy ?? "open";
}

/**
 * Whether the current session may create groups: true when the policy is `open`
 * (anyone) or when the caller is the provider admin. Reactive on both the
 * branding store and `session.isAdmin`.
 */
export function canCreateGroups(): boolean {
  return groupCreationPolicy() === "open" || isAdmin();
}

/** The current brand icon URL (resolved for the page origin), or null. */
export function brandIconUrl(): string | null {
  const url = branding()?.iconUrl;
  return url ? resolveBrandUrl(url) : null;
}

/**
 * Resolve a stored branding URL for use in the page. A bare `/path` is relative
 * to the page origin; an absolute URL on the same host as the page is rewritten
 * to the page origin's scheme (so a canonical `https://localhost:PORT/…` works
 * over the dev `http` origin). Otherwise it's returned unchanged.
 */
function resolveBrandUrl(url: string): string {
  if (typeof location === "undefined") return url;
  if (url.startsWith("/")) return `${location.origin}${url}`;
  try {
    const u = new URL(url);
    if (u.host === location.host) return `${location.origin}${u.pathname}${u.search}`;
    return url;
  } catch {
    return url;
  }
}

/**
 * Apply branding to the document: page title, favicon, and the primary accent
 * CSS variable (`--phosphor`, plus its `-ink` companion for contrast). An unset
 * accent leaves the CSS default; an unset icon leaves the static favicon.
 */
function applyBranding(b: ProviderBranding): void {
  if (typeof document === "undefined") return;
  document.title = b.name;

  if (b.iconUrl) {
    const href = resolveBrandUrl(b.iconUrl);
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    // Drop the static `type="image/svg+xml"` so an uploaded raster icon (png/…)
    // isn't misdeclared; the browser sniffs the served content type.
    link.removeAttribute("type");
    link.href = href;
  }

  const accent = b.accentColor;
  if (accent) {
    document.documentElement.style.setProperty("--phosphor", accent);
    // Pick a readable on-accent ink (the design uses near-black/near-white).
    document.documentElement.style.setProperty("--phosphor-ink", inkFor(accent));
  }
}

/** Choose a contrasting ink color for an `#rrggbb` accent (WCAG-ish luminance). */
function inkFor(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m?.[1]) return "#11120b";
  const n = Number.parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Relative luminance (sRGB approximation); bright accents get dark ink.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#11120b" : "#fbfaf3";
}

/**
 * Fetch the public branding for `host` (defaults to the page origin's host) and
 * apply it. Unauthenticated; tolerant of failure (leaves the static defaults).
 * Returns the loaded branding, or null on failure.
 */
export async function loadBranding(host?: string): Promise<ProviderBranding | null> {
  const target = host ?? (typeof location !== "undefined" ? location.host : "");
  if (!target) return null;
  try {
    const res = await fetch(`${baseUrlForHost(target)}/api/provider`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const b = (await res.json()) as ProviderBranding;
    setBranding(b);
    applyBranding(b);
    return b;
  } catch {
    return null;
  }
}
