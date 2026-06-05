/**
 * Placeholder route screens (P8). Later cards replace these with the real auth,
 * chat, DM, feed and settings UIs; for now each is a themed stub so the shell +
 * routing are verifiable end-to-end.
 */
import type { Component, JSX } from "solid-js";

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
        The app shell, request-signing client, and WebSocket client are wired. Auth, chat, DMs and
        the home feed fill these screens next.
      </p>
    </div>
  </Placeholder>
);

export const LoginPage: Component = () => (
  <Placeholder title="Sign in" sub="Register or log in to your home provider.">
    <div class="card max-w-sm flex flex-col gap-3">
      <input class="input" placeholder="handle" disabled />
      <input class="input" type="password" placeholder="password" disabled />
      <button type="button" class="btn-accent" disabled>
        Continue
      </button>
      <p class="text-xs text-faint">Wired by the auth card.</p>
    </div>
  </Placeholder>
);

export const GroupChannelPage: Component = () => (
  <Placeholder title="Groups" sub="Group + channel view.">
    <div class="card max-w-xl text-sm text-muted">Channel timeline goes here.</div>
  </Placeholder>
);

export const DmsPage: Component = () => (
  <Placeholder title="Direct messages" sub="Your DM conversations.">
    <div class="card max-w-xl text-sm text-muted">DM list + thread go here.</div>
  </Placeholder>
);

export const SettingsPage: Component = () => (
  <Placeholder title="Settings" sub="Account, device keys, providers.">
    <div class="card max-w-xl text-sm text-muted">Device-key + provider settings go here.</div>
  </Placeholder>
);

export const NotFoundPage: Component = () => (
  <Placeholder title="Not found" sub="That screen doesn't exist.">
    <a class="btn-ghost" href="/">
      Back home
    </a>
  </Placeholder>
);
