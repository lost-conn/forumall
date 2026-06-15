/**
 * Settings shell — the design's two-column settings layout (screenshot 06 /
 * settings.jsx): a `pr-setnav` rail grouped into USER / COMMUNITY, beside a body
 * that swaps to the selected section. Reuses the existing settings cards
 * (Account, Profile, Appearance, Privacy, Device keys) and adds a read-only
 * Federation page. Moderation / Audit are listed but disabled (server epics).
 */
import { type Component, For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { doLogout } from "../stores/auth-controller.ts";
import { session, sessionClient } from "../stores/session.ts";
import { DeviceKeys } from "./DeviceKeys.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { BrandingSettings } from "./admin/BrandingSettings.tsx";
import { DiscoverSettings } from "./admin/DiscoverSettings.tsx";
import { AppearanceSettings } from "./social/AppearanceSettings.tsx";
import { NotificationSettings } from "./social/NotificationSettings.tsx";
import { PrivacySettingsCard, ProfileSettings } from "./social/PrivacyProfileSettings.tsx";

type Section =
  | "account"
  | "profile"
  | "appearance"
  | "notifications"
  | "privacy"
  | "devices"
  | "federation"
  | "branding"
  | "discover";

const NAV: { group: string; items: [Section, string, IconName][] }[] = [
  {
    group: "user",
    items: [
      ["account", "My Account", "at"],
      ["profile", "Profile", "users"],
      ["appearance", "Appearance", "gear"],
      ["notifications", "Notifications", "bell"],
      ["privacy", "Privacy & Safety", "lock"],
      ["devices", "Device keys", "lock"],
      ["federation", "Federation", "globe"],
    ],
  },
];

const COMMUNITY: [string, IconName][] = [
  ["Moderation", "users"],
  ["Audit log", "article"],
];

/** Provider-admin nav items (shown only when `session.isAdmin`). */
const PROVIDER_NAV: [Section, string, IconName][] = [
  ["branding", "Branding", "gear"],
  ["discover", "Discover", "globe"],
];

interface MeAccount {
  profile: { handle: string; domain: string; displayName?: string };
}

async function fetchMe(): Promise<MeAccount> {
  const client = sessionClient();
  if (!client) throw new Error("not authenticated");
  const res = await client.get<MeAccount>("/api/me");
  return res.data;
}

export const SettingsShell: Component = () => {
  const [section, setSection] = createSignal<Section>("account");
  const [me] = createResource(fetchMe);

  return (
    <div class="flex min-h-0 flex-1 flex-col md:flex-row" data-testid="settings-page">
      {/* setnav — a top strip on mobile (capped + scrollable), a sidebar on desktop. */}
      <nav class="max-h-44 w-full shrink-0 overflow-auto border-b border-border bg-surface px-2.5 py-2 fa-scroll md:max-h-none md:w-[210px] md:border-r md:border-b-0">
        <For each={NAV}>
          {(grp) => (
            <>
              <div class="eyebrow px-2 pb-1.5 pt-2">{grp.group}</div>
              <For each={grp.items}>
                {([id, label, icon]) => (
                  <button
                    type="button"
                    class="mb-0.5 flex w-full items-center gap-2.5 rounded-md border-[1.5px] px-2.5 py-1.5 text-left font-mono text-[13px] transition-colors"
                    classList={{
                      "border-accent bg-accent-soft text-accent": section() === id,
                      "border-transparent text-muted hover:(bg-surface-2 text-ink)":
                        section() !== id,
                    }}
                    data-testid={`settings-nav-${id}`}
                    onClick={() => setSection(id)}
                  >
                    <Icon name={icon} size={15} />
                    {label}
                  </button>
                )}
              </For>
            </>
          )}
        </For>
        <Show when={session.isAdmin}>
          <div class="eyebrow px-2 pb-1.5 pt-4">provider</div>
          <For each={PROVIDER_NAV}>
            {([id, label, icon]) => (
              <button
                type="button"
                class="mb-0.5 flex w-full items-center gap-2.5 rounded-md border-[1.5px] px-2.5 py-1.5 text-left font-mono text-[13px] transition-colors"
                classList={{
                  "border-accent bg-accent-soft text-accent": section() === id,
                  "border-transparent text-muted hover:(bg-surface-2 text-ink)": section() !== id,
                }}
                data-testid={`settings-nav-${id}`}
                onClick={() => setSection(id)}
              >
                <Icon name={icon} size={15} />
                {label}
              </button>
            )}
          </For>
        </Show>

        <div class="eyebrow px-2 pb-1.5 pt-4">community</div>
        <For each={COMMUNITY}>
          {([label, icon]) => (
            <div
              class="mb-0.5 flex w-full items-center gap-2.5 rounded-md px-3 py-2 font-mono text-[13px] text-faint"
              title="Moderation tools are coming soon"
            >
              <Icon name={icon} size={15} />
              <span class="flex-1">{label}</span>
              <span class="fa-meta">soon</span>
            </div>
          )}
        </For>

        <button
          type="button"
          class="mt-4 flex w-full items-center gap-2.5 rounded-md border-[1.5px] border-transparent px-3 py-2 text-left font-mono text-[13px] text-muted transition-colors hover:(border-danger text-danger)"
          onClick={() => void doLogout()}
          data-testid="logout"
        >
          <Icon name="x" size={15} />
          Log out
        </button>
      </nav>

      {/* setbody */}
      <div class="min-h-0 flex-1 overflow-auto px-4 py-5 fa-scroll md:px-7 md:py-[26px]">
        <div class="mx-auto max-w-2xl">
          <Switch>
            <Match when={section() === "account"}>
              <h1 class="fa-h1 mb-5">My Account</h1>
              <section class="card" data-testid="account">
                <Show
                  when={!me.error && !me.loading && me()}
                  fallback={
                    <p class="text-sm text-muted">
                      {me.error ? "Could not load account." : "Loading account…"}
                    </p>
                  }
                >
                  {(account) => (
                    <dl class="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
                      <dt class="text-muted">Handle</dt>
                      <dd class="font-mono text-ink" data-testid="me-handle">
                        {account().profile.handle}
                      </dd>
                      <dt class="text-muted">Provider</dt>
                      <dd class="font-mono text-ink" data-testid="me-domain">
                        {account().profile.domain}
                      </dd>
                      <dt class="text-muted">Actor</dt>
                      <dd class="font-mono text-ink" data-testid="me-actor">
                        {session.actor}
                      </dd>
                    </dl>
                  )}
                </Show>
              </section>
            </Match>

            <Match when={section() === "profile"}>
              <h1 class="fa-h1 mb-5">Profile</h1>
              <ProfileSettings />
            </Match>

            <Match when={section() === "appearance"}>
              <h1 class="fa-h1 mb-5">Appearance</h1>
              <AppearanceSettings />
            </Match>

            <Match when={section() === "notifications"}>
              <h1 class="fa-h1 mb-5">Notifications</h1>
              <NotificationSettings />
            </Match>

            <Match when={section() === "privacy"}>
              <h1 class="fa-h1 mb-5">Privacy &amp; Safety</h1>
              <PrivacySettingsCard />
            </Match>

            <Match when={section() === "devices"}>
              <h1 class="fa-h1 mb-5">Device keys</h1>
              <DeviceKeys />
            </Match>

            <Match when={section() === "federation"}>
              <FederationInfo />
            </Match>

            <Match when={section() === "branding" && session.isAdmin}>
              <h1 class="fa-h1 mb-5">Provider branding</h1>
              <BrandingSettings />
            </Match>

            <Match when={section() === "discover" && session.isAdmin}>
              <h1 class="fa-h1 mb-5">Discover feed</h1>
              <DiscoverSettings />
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
};

/**
 * Read-only Federation view. OFSCP §8 mandates only a binary allow/deny policy,
 * configured server-side via FEDERATION_ALLOW / FEDERATION_DENY. Runtime-editable
 * per-instance policy + a public mod-log (the design's Allow/Limit/Block) are a
 * §13 moderation epic beyond v0.1 — surfaced here as an informational page.
 */
const POLICY_OPTIONS: [string, string][] = [
  ["allow", "Allow all"],
  ["approve", "Approve"],
  ["block", "Block all"],
];

const FederationInfo: Component = () => {
  // Read-only: v0.1 mandates only a binary allow/deny policy, set server-side.
  const policy = "allow";
  return (
    <div data-testid="federation-info">
      <div class="mb-1.5 flex items-center justify-between gap-3">
        <h1 class="fa-h1">Federation</h1>
        <span class="pill">
          <Icon name="globe" size={13} />
          Open · talks to all
        </span>
      </div>
      <p class="mb-[18px] text-sm text-muted">
        Decide which instances your community federates with. You're in control.
      </p>

      {/* Default policy card */}
      <div class="card mb-5 flex items-center gap-[14px]">
        <span class="text-accent">
          <Icon name="globe" size={20} />
        </span>
        <div class="flex-1">
          <div class="font-display text-sm font-bold tracking-tight">Default policy</div>
          <div class="fa-meta">How to treat instances not listed below</div>
        </div>
        <div class="flex flex-wrap gap-[5px]">
          <For each={POLICY_OPTIONS}>
            {([key, label]) => (
              <span
                class="inline-flex items-center rounded-[6px] border-[1.5px] border-border-strong px-[9px] py-1 font-mono text-[11.5px]"
                classList={{
                  "bg-accent text-accent-ink": policy === key,
                  "bg-surface text-ink": policy !== key,
                }}
              >
                {label}
              </span>
            )}
          </For>
        </div>
      </div>

      {/* Instance policies */}
      <div class="mb-2 flex items-center justify-between">
        <span class="eyebrow">Instance policies</span>
      </div>
      <div class="card overflow-hidden p-0">
        <div class="px-[14px] py-[18px] text-center">
          <p class="text-xs text-faint" data-testid="federation-instances-empty">
            Per-instance allow / limit / block lists are configured server-side via{" "}
            <code class="rounded-sm border-[1.5px] border-border bg-surface-2 px-1 py-0.5 font-mono">
              FEDERATION_ALLOW
            </code>{" "}
            /{" "}
            <code class="rounded-sm border-[1.5px] border-border bg-surface-2 px-1 py-0.5 font-mono">
              FEDERATION_DENY
            </code>
            .
          </p>
        </div>
      </div>

      {/* Public moderation log row */}
      <div class="mt-[18px] flex items-center gap-3 border-b border-dashed border-border py-3">
        <div class="flex-1">
          <div class="font-body text-[13.5px] text-ink">Publish a public moderation log</div>
          <div class="fa-meta mt-[3px]">Transparency for members &amp; peer instances</div>
        </div>
        <span class="fa-switch" aria-hidden="true">
          <span class="fa-switch__knob" />
        </span>
      </div>
      <p class="mt-3 text-xs text-faint">
        Runtime per-instance controls and a public moderation log are planned (§13 moderation).
      </p>
    </div>
  );
};
