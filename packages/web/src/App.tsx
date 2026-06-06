import { Route, Router } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { type Component, ErrorBoundary, Show, Suspense, createSignal, onMount } from "solid-js";
import { AppShell } from "./components/AppShell";
import { AuthScreen } from "./components/AuthScreen";
import { loadProviderHost, probeProvider } from "./lib/provider";
import {
  DmsPage,
  GroupChannelPage,
  HomePage,
  LoginPage,
  NotFoundPage,
  SettingsPage,
} from "./routes/pages";
import { doRestore } from "./stores/auth-controller";
import { isAuthenticated, provider, setProvider } from "./stores/session";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

/** The routed, authenticated application. */
const AuthedApp: Component = () => (
  <Router root={AppShell}>
    <Route path="/" component={HomePage} />
    <Route path="/login" component={LoginPage} />
    <Route path="/groups/:groupId?/:channelId?" component={GroupChannelPage} />
    <Route path="/dms/:dmId?" component={DmsPage} />
    <Route path="/settings" component={SettingsPage} />
    <Route path="*" component={NotFoundPage} />
  </Router>
);

/**
 * Decides between the auth screen and the app. On mount it (a) restores a
 * persisted session + private key from storage so a reload stays authenticated
 * with no re-login, and (b) re-confirms any previously-chosen provider so the
 * auth screen can skip straight to the credentials stage.
 */
const AuthGate: Component = () => {
  const [restoring, setRestoring] = createSignal(true);

  onMount(async () => {
    try {
      const restored = await doRestore();
      if (!restored) {
        // Not signed in: if a provider was previously chosen, re-confirm it so
        // the user lands on the credentials stage rather than re-entering a host.
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
  });

  return (
    <Show
      when={!restoring()}
      fallback={
        <div class="grid min-h-screen place-items-center bg-canvas text-sm text-muted">
          Restoring session…
        </div>
      }
    >
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
          <AuthedApp />
        </ErrorBoundary>
      </Show>
    </Show>
  );
};

export const App: Component = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <Suspense>
        <AuthGate />
      </Suspense>
    </QueryClientProvider>
  );
};
