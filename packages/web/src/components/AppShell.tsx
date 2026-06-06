import { OFSCP_VERSION } from "@forumall/shared";
import { A, useLocation } from "@solidjs/router";
import { For, type ParentComponent, Show } from "solid-js";
import { session } from "../stores/session";
import { SelfPresenceControl } from "./social/SelfPresenceControl";

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
      <nav class="app-nav">
        <div class="mb-4 flex items-center gap-2.5 px-2">
          <span class="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-cyan text-sm font-bold text-white">
            F
          </span>
          <div class="leading-tight">
            <div class="text-sm font-semibold tracking-tight">Forumall</div>
            <div class="text-[10px] text-faint">OFSCP v{OFSCP_VERSION}</div>
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

      <main class="app-content">{props.children}</main>
    </div>
  );
};
