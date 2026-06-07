import { OFSCP_VERSION } from "@forumall/shared";
import { A, useLocation } from "@solidjs/router";
import { For, type ParentComponent, Show } from "solid-js";
import { session } from "../stores/session";
import { SelfPresenceControl } from "./social/SelfPresenceControl";
import { UserProfileCard } from "./social/UserProfileCard";

interface NavItem {
  href: string;
  label: string;
  glyph: string;
}

const NAV: NavItem[] = [
  { href: "/", label: "Home", glyph: "◆" },
  { href: "/discover", label: "Discover", glyph: "✦" },
  { href: "/groups", label: "Groups", glyph: "❑" },
  { href: "/dms", label: "Direct messages", glyph: "✉" },
  { href: "/contacts", label: "Contacts", glyph: "☺" },
  { href: "/settings", label: "Settings", glyph: "⚙" },
];

/**
 * Phone bottom tab bar (shown < md). A 5-item subset of the rail — Home · Forum
 * (Groups) · DMs · Discover · You (Settings) — matching the handoff mobile shell.
 */
const MOBILE_NAV: { href: string; label: string; glyph: string }[] = [
  { href: "/", label: "Home", glyph: "◆" },
  { href: "/groups", label: "Forum", glyph: "❑" },
  { href: "/dms", label: "DMs", glyph: "✉" },
  { href: "/discover", label: "Discover", glyph: "✦" },
  { href: "/settings", label: "You", glyph: "⚙" },
];

const CONNECTION_DOT: Record<string, string> = {
  connected: "bg-success",
  connecting: "bg-cyan animate-pulse",
  authenticating: "bg-cyan animate-pulse",
  reconnecting: "bg-danger animate-pulse",
  closed: "bg-faint",
  idle: "bg-faint",
};

/** App layout: a left nav rail + a content outlet, themed via UnoCSS tokens. */
export const AppShell: ParentComponent = (props) => {
  const location = useLocation();
  const isActive = (href: string) =>
    href === "/" ? location.pathname === "/" : location.pathname.startsWith(href);

  return (
    <div class="app-shell">
      <nav class="app-nav hidden md:flex">
        <div class="mb-4 flex items-center gap-2.5 px-2">
          <img src="/forumall-mark.svg" alt="Forumall" class="h-8 w-8" width="32" height="32" />
          <div class="leading-tight">
            <div class="font-display text-sm font-bold tracking-tight">Forumall</div>
            <div class="eyebrow text-[10px]">OFSCP v{OFSCP_VERSION}</div>
          </div>
        </div>

        <For each={NAV}>
          {(item) => (
            <A
              href={item.href}
              class="nav-link"
              classList={{ "nav-link-active": isActive(item.href) }}
            >
              <span class="w-4 text-center text-faint">{item.glyph}</span>
              <span>{item.label}</span>
            </A>
          )}
        </For>

        <div class="mt-auto pt-4">
          <Show when={session.actor}>
            <SelfPresenceControl />
          </Show>
          <div class="px-2">
            <div class="badge w-full justify-start">
              <span
                class={`h-2 w-2 rounded-full ${CONNECTION_DOT[session.connection] ?? "bg-faint"}`}
              />
              <Show when={session.actor} fallback={<span>Signed out</span>}>
                <span class="truncate">{session.actor}</span>
              </Show>
            </div>
          </div>
        </div>
      </nav>

      <main class="app-content pb-14 md:pb-0">{props.children}</main>

      {/* Phone bottom tab bar (hidden ≥ md). */}
      <nav
        class="fixed inset-x-0 bottom-0 z-40 flex h-14 border-t-[1.5px] border-border-strong bg-surface md:hidden"
        data-testid="mobile-tabbar"
      >
        <For each={MOBILE_NAV}>
          {(item) => (
            <A
              href={item.href}
              class="flex flex-1 flex-col items-center justify-center gap-0.5 font-mono text-[10px] uppercase tracking-wide text-muted"
              classList={{ "text-accent": isActive(item.href) }}
            >
              <span class="text-base leading-none">{item.glyph}</span>
              <span>{item.label}</span>
            </A>
          )}
        </For>
      </nav>

      {/* Global, opened from anywhere via openUserProfile(actor). */}
      <UserProfileCard />
    </div>
  );
};
