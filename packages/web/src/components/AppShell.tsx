import { A, useLocation } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import {
  type Component,
  For,
  type JSX,
  type ParentComponent,
  Show,
  createEffect,
  createSignal,
} from "solid-js";
import { resolveAttachmentUrl } from "../lib/chat-api";
import { displayNameFor, warmProfile } from "../stores/profiles";
import { unreadForGroup } from "../stores/read-markers";
import { session } from "../stores/session";
import { Icon, type IconName } from "./Icon";
import { myGroupsQuery } from "./groups/queries";
import { UnreadBadge } from "./shared/UnreadBadge";
import { Avatar } from "./social/Avatar";
import { SelfPresenceControl } from "./social/SelfPresenceControl";
import { UserProfileCard } from "./social/UserProfileCard";

/** First-letter fallback for the signed-in user's avatar. */
function meInitial(actor: string): string {
  return displayNameFor(actor).slice(0, 1).toUpperCase();
}

/** Phone bottom-tab + space-rail nav targets (icon-driven). */
const MOBILE_NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/groups", label: "Forum", icon: "hash" },
  { href: "/dms", label: "DMs", icon: "at" },
  { href: "/discover", label: "Discover", icon: "globe" },
  { href: "/settings", label: "You", icon: "users" },
];

/** App layout: a narrow icon "space rail" + a content outlet (+ phone tab bar). */
export const AppShell: ParentComponent = (props) => {
  const location = useLocation();
  const isActive = (href: string) =>
    href === "/" ? location.pathname === "/" : location.pathname.startsWith(href);

  const groups = useQuery(myGroupsQuery);

  // Warm the signed-in user's own profile so their avatar (settings entries,
  // etc.) resolves — nothing else fetches self at startup.
  createEffect(() => {
    const actor = session.actor;
    if (actor) warmProfile(actor);
  });

  return (
    <div class="app-shell">
      {/* Space rail (hidden < md) */}
      <nav
        class="hidden w-16 shrink-0 flex-col items-center gap-2.5 border-r border-border bg-surface py-3 md:flex"
        data-testid="space-rail"
      >
        <A
          href="/"
          title="Home"
          class="grid h-11 w-11 place-items-center rounded-md border-[1.5px] bg-accent-soft transition-colors"
          classList={{
            "border-accent": isActive("/"),
            "border-border-strong": !isActive("/"),
          }}
        >
          <img src="/forumall-mark.svg" alt="Forumall" class="h-7 w-7" width="28" height="28" />
        </A>

        <RailButton href="/dms" label="Inbox & DMs" icon="inbox" active={isActive("/dms")} />

        <div class="my-0.5 h-0 w-6 border-t border-border" />

        {/* Group "spaces" — avatars linking into each group. */}
        <div class="flex w-full flex-col items-center gap-2 overflow-y-auto">
          <For each={groups.data ?? []}>
            {(grp) => {
              const active = () => location.pathname.startsWith(`/groups/${grp.id}`);
              return (
                <A
                  href={`/groups/${grp.id}`}
                  title={grp.name}
                  class="fa-ava fa-ava--rail relative transition-colors"
                  classList={{ "fa-ava--phosphor": active() }}
                  data-testid="my-group-item"
                  data-group-name={grp.name}
                >
                  <RailGroupAvatar name={grp.name} avatar={grp.avatar} />
                  <UnreadBadge count={unreadForGroup(grp.id)} />
                </A>
              );
            }}
          </For>
          <A
            href="/groups"
            title="Groups"
            class="grid h-11 w-11 place-items-center rounded-md border-[1.5px] border-dashed border-border-strong text-muted transition-colors hover:(border-accent text-accent)"
            classList={{ "border-accent text-accent": location.pathname === "/groups" }}
            data-testid="rail-groups"
          >
            <Icon name="plus" size={18} />
          </A>
        </div>

        <div class="mt-auto flex flex-col items-center gap-2.5">
          <RailButton
            href="/discover"
            label="Discover instances"
            icon="globe"
            active={isActive("/discover")}
          />
          <RailButton
            href="/contacts"
            label="Contacts"
            icon="users"
            active={isActive("/contacts")}
          />
          <Show when={session.actor}>
            <SelfPresenceControl />
            {/* Signed-in identity — exposed to AT users + the e2e login gate. */}
            <span class="sr-only" data-testid="rail-actor">
              {session.actor}
            </span>
          </Show>
          <RailButton
            href="/settings"
            label="Settings"
            icon="gear"
            active={isActive("/settings")}
            avatarActor={session.actor ?? undefined}
          />
        </div>
      </nav>

      <main class="app-content pb-14 md:pb-0">{props.children}</main>

      {/* Phone bottom tab bar (hidden ≥ md). */}
      <nav
        class="fixed inset-x-0 bottom-0 z-40 flex h-14 border-t-[1.5px] border-border bg-surface md:hidden"
        data-testid="mobile-tabbar"
      >
        <For each={MOBILE_NAV}>
          {(item) => (
            <A
              href={item.href}
              class="flex flex-1 flex-col items-center justify-center gap-0.5 font-mono text-[9.5px] text-faint"
              classList={{ "text-accent": isActive(item.href) }}
            >
              <Show
                when={item.href === "/settings" && session.actor}
                fallback={<Icon name={item.icon} size={20} />}
              >
                {(actor) => (
                  <span
                    class="grid h-5 w-5 place-items-center overflow-hidden rounded-full border-[1.5px] border-border-strong bg-surface-2 text-[9px] font-semibold text-ink"
                    data-testid="mobile-me-avatar"
                  >
                    <Avatar actor={actor()} initials={meInitial(actor())} />
                  </span>
                )}
              </Show>
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

/**
 * The inner content of a space-rail group slot: the group's avatar image when
 * one is set, else the group-name initial. Lives inside the existing `fa-ava`
 * slot (which clips to the round shape), mirroring the user {@link Avatar}.
 * `onError` flips back to the initial so a broken URL never shows a broken-image
 * glyph.
 */
const RailGroupAvatar: Component<{ name: string; avatar?: string }> = (props) => {
  const [failed, setFailed] = createSignal(false);
  const src = () => {
    const url = props.avatar?.trim();
    return url ? resolveAttachmentUrl(url) : undefined;
  };
  createEffect(() => {
    src();
    setFailed(false);
  });
  return (
    <Show when={src() && !failed()} fallback={props.name.slice(0, 1).toUpperCase()}>
      <img
        src={src()}
        alt=""
        class="h-full w-full object-cover"
        data-testid="rail-group-avatar-image"
        onError={() => setFailed(true)}
      />
    </Show>
  );
};

/** One icon button in the space rail, with the phosphor active state. */
const RailButton: Component<{
  href: string;
  label: string;
  icon: IconName;
  active: boolean;
  /** When set (signed-in actor), render the user's avatar instead of `icon`. */
  avatarActor?: string;
}> = (props): JSX.Element => (
  <A
    href={props.href}
    title={props.label}
    aria-label={props.label}
    class="grid h-11 w-11 place-items-center rounded-md border-[1.5px] transition-colors"
    classList={{
      "border-accent bg-accent-soft text-accent": props.active,
      "border-transparent text-muted hover:(bg-surface-2 text-ink)": !props.active,
    }}
  >
    <Show when={props.avatarActor} fallback={<Icon name={props.icon} size={20} />}>
      {(actor) => (
        <span
          class="grid h-7 w-7 place-items-center overflow-hidden rounded-full border-[1.5px] border-border-strong bg-surface-2 text-xs font-semibold text-ink"
          data-testid="rail-me-avatar"
        >
          <Avatar actor={actor()} initials={meInitial(actor())} />
        </span>
      )}
    </Show>
  </A>
);
