/**
 * Route screens (P8). The auth card fills in Settings (account + device keys);
 * later cards replace the remaining themed stubs with the real chat, DM and feed
 * UIs. Each stub keeps the shell + routing verifiable end-to-end.
 */
import type { Component, JSX } from "solid-js";
import { SettingsShell } from "../components/SettingsShell.tsx";
import { DmsPage as DmsPageImpl } from "../components/dms/DmsPage.tsx";
import { DiscoverPage } from "../components/feed/DiscoverPage.tsx";
import { HomeFeed } from "../components/feed/HomeFeed.tsx";
import { GroupsPage } from "../components/groups/GroupsPage.tsx";
import { ContactsPage } from "../components/social/ContactsPage.tsx";

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

/** Settings: a two-column shell (nav + section body) per the design. */
export const SettingsPage: Component = () => <SettingsShell />;

export const NotFoundPage: Component = () => (
  <Placeholder title="Not found" sub="That screen doesn't exist.">
    <a class="btn-ghost" href="/">
      Back home
    </a>
  </Placeholder>
);
