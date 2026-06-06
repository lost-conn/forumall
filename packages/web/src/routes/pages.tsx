/**
 * Route screens (P8). The auth card fills in Settings (account + device keys);
 * later cards replace the remaining themed stubs with the real chat, DM and feed
 * UIs. Each stub keeps the shell + routing verifiable end-to-end.
 */
import { type Component, type JSX, Show, createResource } from "solid-js";
import { DeviceKeys } from "../components/DeviceKeys.tsx";
import { GroupsPage } from "../components/groups/GroupsPage.tsx";
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

export const HomePage: Component = () => (
  <Placeholder title="Home" sub="Your federated feed lands here.">
    <div class="card max-w-xl">
      <p class="text-sm text-muted">
        You're signed in as <span class="font-mono text-ink">{session.actor}</span>. Auth, device
        keys and account live under Settings; chat, DMs and the home feed fill these screens next.
      </p>
    </div>
  </Placeholder>
);

export const LoginPage: Component = () => (
  <Placeholder title="Sign in" sub="Register or log in to your home provider.">
    <div class="card max-w-sm text-sm text-muted">
      You're already signed in. The auth screen shows automatically when signed out.
    </div>
  </Placeholder>
);

/** Groups & channels screen (P8): browse, create, manage, membership, invites. */
export const GroupsRoutePage: Component = () => <GroupsPage />;

export const DmsPage: Component = () => (
  <Placeholder title="Direct messages" sub="Your DM conversations.">
    <div class="card max-w-xl text-sm text-muted">DM list + thread go here.</div>
  </Placeholder>
);

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
