import { Route, Router } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import {
  type Component,
  ErrorBoundary,
  type ParentComponent,
  Show,
  Suspense,
  createSignal,
  onMount,
} from "solid-js";
import { AppShell } from "./components/AppShell";
import { AuthScreen } from "./components/AuthScreen";
import { InviteRedeemPage } from "./components/groups/InviteRedeemPage";
import { loadProviderHost, probeProvider } from "./lib/provider";
import {
  ContactsRoutePage,
  DiscoverRoutePage,
  DmsPage,
  GroupsRoutePage,
  HomePage,
  LoginPage,
  NotFoundPage,
  SettingsPage,
} from "./routes/pages";
import { doRestore } from "./stores/auth-controller";
import { loadBranding } from "./stores/branding";
import { isAuthenticated, provider, setProvider } from "./stores/session";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

/**
 * Restores a persisted session + re-confirms any chosen provider on mount, then
 * exposes `ready()` so the routed roots can swap the "restoring" placeholder for
 * real content. Lifted above the Router so the `/invite/{token}` redeem page is
 * routable whether or not the user is signed in.
 */
const [restoring, setRestoring] = createSignal(true);
async function bootstrapSession(): Promise<void> {
  // Provider branding is PUBLIC — apply the instance title/favicon/accent/name
  // as early as possible (independent of the session restore below).
  void loadBranding();
  try {
    const restored = await doRestore();
    if (!restored) {
      const host = loadProviderHost();
      if (host && !provider()) {
        try {
          setProvider(await probeProvider(host));
        } catch {
          /* provider unreachable now: fall back to the connect stage */
        }
      }
    }
  } finally {
    setRestoring(false);
  }
}

const Restoring: Component = () => (
  <div class="grid min-h-screen place-items-center bg-canvas text-sm text-muted">
    Restoring session…
  </div>
);

/**
 * The authenticated app root layout: gates the shell behind a live session.
 * Signed-out users get the auth/onboarding screen instead.
 */
const AuthedRoot: ParentComponent = (props) => (
  <Show when={!restoring()} fallback={<Restoring />}>
    <Show when={isAuthenticated()} fallback={<AuthScreen />}>
      <ErrorBoundary
        fallback={(err, reset) => (
          <div class="grid min-h-screen place-items-center bg-canvas px-4">
            <div class="card max-w-md text-center" data-testid="app-error">
              <p class="text-sm text-danger">Something went wrong loading the app.</p>
              <p class="mt-1 text-xs text-faint">{String(err)}</p>
              <button type="button" class="btn-ghost mt-4" onClick={reset}>
                Retry
              </button>
            </div>
          </div>
        )}
      >
        <AppShell>{props.children}</AppShell>
      </ErrorBoundary>
    </Show>
  </Show>
);

/** The invite-redeem root: routable signed in OR out (guest provisioning). */
const InviteRoot: Component = () => (
  <Show when={!restoring()} fallback={<Restoring />}>
    <InviteRedeemPage />
  </Show>
);

export const App: Component = () => {
  onMount(bootstrapSession);
  return (
    <QueryClientProvider client={queryClient}>
      <Suspense>
        <Router>
          {/* Invite redemption — outside the auth gate so guests can join. */}
          <Route path="/invite/:token" component={InviteRoot} />
          {/* The authenticated application. */}
          <Route path="/" component={AuthedRoot}>
            <Route path="/" component={HomePage} />
            <Route path="/discover" component={DiscoverRoutePage} />
            <Route path="/login" component={LoginPage} />
            <Route path="/groups/:groupId?" component={GroupsRoutePage} />
            <Route path="/dms/:dmId?" component={DmsPage} />
            <Route path="/contacts" component={ContactsRoutePage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="*" component={NotFoundPage} />
          </Route>
        </Router>
      </Suspense>
    </QueryClientProvider>
  );
};
