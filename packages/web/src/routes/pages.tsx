/**
 * Route screens (P8). The auth card fills in Settings (account + device keys);
 * later cards replace the remaining themed stubs with the real chat, DM and feed
 * UIs. Each stub keeps the shell + routing verifiable end-to-end.
 */
import { type Component, type JSX, Show, createResource } from "solid-js";
import { DeviceKeys } from "../components/DeviceKeys.tsx";
import { DmsPage as DmsPageImpl } from "../components/dms/DmsPage.tsx";
import { DiscoverPage } from "../components/feed/DiscoverPage.tsx";
import { HomeFeed } from "../components/feed/HomeFeed.tsx";
import { GroupsPage } from "../components/groups/GroupsPage.tsx";
import { ContactsPage } from "../components/social/ContactsPage.tsx";
import {
  PrivacySettingsCard,
  ProfileSettings,
} from "../components/social/PrivacyProfileSettings.tsx";
import { doLogout } from "../stores/auth-controller.ts";
import { session, sessionClient } from "../stores/session.ts";

const Placeholder: Component<{ title: string; sub: string; children?: JSX.Element }> = (props) => (
  <div class="flex-1 overflow-auto">
    <header class="border-b border-border px-8 py-5">
      <h1 class="text-lg font-semibold tracking-tight">{props.title}</h1>
      <p class="mt-0.5 text-sm text-muted">{props.sub}</p>
    </header>
    <div class="p-8">{props.children}</div>
  </div>
);

/** Home (§7.6): the client-composed feed across the channels you follow. */
export const HomePage: Component = () => <HomeFeed />;

/** Discover (§11.2): browse this provider's discoverable channel pointers. */
export const DiscoverRoutePage: Component = () => <DiscoverPage />;

export const LoginPage: Component = () => (
  <Placeholder title="Sign in" sub="Register or log in to your home provider.">
    <div class="card max-w-sm text-sm text-muted">
      You're already signed in. The auth screen shows automatically when signed out.
    </div>
  </Placeholder>
);

/** Groups & channels screen (P8): browse, create, manage, membership, invites. */
export const GroupsRoutePage: Component = () => <GroupsPage />;

/** Direct messages screen (§7.4 / §8.3): conversation list + live thread. */
export const DmsPage: Component = () => <DmsPageImpl />;

/** Contacts screen (§6.7): contacts + pending requests, with live presence. */
export const ContactsRoutePage: Component = () => <ContactsPage />;

interface MeProfile {
  handle: string;
  domain: string;
  displayName?: string;
}
interface MeAccount {
  profile: MeProfile;
}

async function fetchMe(): Promise<MeAccount> {
  const client = sessionClient();
  if (!client) throw new Error("not authenticated");
  const res = await client.get<MeAccount>("/api/me");
  return res.data;
}

/** Settings: account (signed `GET /api/me`), device keys, and logout. */
export const SettingsPage: Component = () => {
  const [me] = createResource(fetchMe);

  return (
    <Placeholder title="Settings" sub="Account, device keys, providers.">
      <div class="flex max-w-xl flex-col gap-6">
        <section class="card" data-testid="account">
          <h2 class="mb-3 text-sm font-semibold tracking-tight">Account</h2>
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

        <ProfileSettings />

        <PrivacySettingsCard />

        <DeviceKeys />

        <section class="card flex items-center justify-between">
          <div>
            <h2 class="text-sm font-semibold tracking-tight">Sign out</h2>
            <p class="mt-0.5 text-xs text-muted">
              Revokes this device's key and removes its private key from this browser.
            </p>
          </div>
          <button
            type="button"
            class="btn-ghost hover:(border-danger text-danger)"
            onClick={() => void doLogout()}
            data-testid="logout"
          >
            Log out
          </button>
        </section>
      </div>
    </Placeholder>
  );
};

export const NotFoundPage: Component = () => (
  <Placeholder title="Not found" sub="That screen doesn't exist.">
    <a class="btn-ghost" href="/">
      Back home
    </a>
  </Placeholder>
);
