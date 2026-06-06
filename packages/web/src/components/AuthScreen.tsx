/**
 * Auth & onboarding screen (P8, spec §4.1–§4.3).
 *
 * Two stages, shown when the user is not authenticated:
 *
 *  1. **Connect to provider** — enter the provider domain (defaulting to the
 *     current origin's host), probe `/.well-known/ofscp-provider`, and confirm
 *     it is a real OFSCP provider (showing its name + protocol version).
 *  2. **Register / Sign in** — handle + password (+ optional recovery email on
 *     register). On submit the controller runs the bootstrap → in-browser
 *     keygen → device-key → store flow and lands the user authenticated.
 *
 * All heavy lifting lives in the auth controller / lib; this is presentation +
 * form state only.
 */
import { type Component, Match, Show, Switch, createSignal } from "solid-js";
import { OfscpHttpError } from "../lib/ofscp-client.ts";
import {
  type ProviderInfo,
  defaultProviderHost,
  probeProvider,
  storeProviderHost,
} from "../lib/provider.ts";
import { doLogin, doRegister } from "../stores/auth-controller.ts";
import { provider, setProvider } from "../stores/session.ts";

type Mode = "login" | "register";

/** Distill an unknown error into a user-facing message. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof OfscpHttpError) {
    const body = err.body as { detail?: string } | undefined;
    return body?.detail ?? `Request failed (${err.status}).`;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export const AuthScreen: Component = () => {
  return (
    <div class="grid min-h-screen place-items-center bg-canvas px-4">
      <div class="w-full max-w-md">
        <div class="mb-7 flex items-center gap-3">
          <span class="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-accent to-cyan text-lg font-bold text-white">
            F
          </span>
          <div>
            <div class="text-xl font-semibold tracking-tight text-ink">Forumall</div>
            <div class="text-xs text-faint">Federated communities over OFSCP</div>
          </div>
        </div>

        <Show when={provider()} fallback={<ConnectStage />}>
          {(p) => <CredentialsStage info={p()} />}
        </Show>
      </div>
    </div>
  );
};

/** Stage 1: choose + confirm the provider. */
const ConnectStage: Component = () => {
  const [host, setHost] = createSignal(defaultProviderHost());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const connect = async (e: Event) => {
    e.preventDefault();
    const h = host()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
    if (!h) {
      setError("Enter a provider domain.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const info: ProviderInfo = await probeProvider(h);
      storeProviderHost(h);
      setProvider(info);
    } catch (err) {
      setError(errorMessage(err, "Could not reach that provider."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="card flex flex-col gap-4" onSubmit={connect} data-testid="connect-form">
      <div>
        <h1 class="text-lg font-semibold tracking-tight">Connect to your provider</h1>
        <p class="mt-1 text-sm text-muted">
          Enter the domain of the OFSCP provider that hosts your account.
        </p>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-muted">Provider domain</span>
        <input
          class="input font-mono"
          name="host"
          autocomplete="url"
          placeholder="providera.com"
          value={host()}
          onInput={(e) => setHost(e.currentTarget.value)}
          disabled={busy()}
        />
      </label>

      <Show when={error()}>
        <p class="text-sm text-danger" role="alert" data-testid="connect-error">
          {error()}
        </p>
      </Show>

      <button type="submit" class="btn-accent" disabled={busy()} data-testid="connect-submit">
        {busy() ? "Checking…" : "Continue"}
      </button>
    </form>
  );
};

/** Stage 2: register or sign in against the confirmed provider. */
const CredentialsStage: Component<{ info: ProviderInfo }> = (props) => {
  const [mode, setMode] = createSignal<Mode>("register");
  const [handle, setHandle] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [recoveryEmail, setRecoveryEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    const h = handle().trim().toLowerCase();
    if (!h || !password()) {
      setError("Handle and password are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode() === "register") {
        await doRegister({
          host: props.info.host,
          handle: h,
          password: password(),
          ...(recoveryEmail().trim() ? { recoveryEmail: recoveryEmail().trim() } : {}),
        });
      } else {
        await doLogin({ host: props.info.host, handle: h, password: password() });
      }
      // On success the session store flips to authenticated and the shell swaps
      // this screen for the app — nothing else to do here.
    } catch (err) {
      setError(
        errorMessage(err, mode() === "register" ? "Registration failed." : "Sign-in failed."),
      );
    } finally {
      setBusy(false);
    }
  };

  const switchProvider = () => setProvider(null);

  return (
    <form class="card flex flex-col gap-4" onSubmit={submit} data-testid="credentials-form">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h1 class="text-lg font-semibold tracking-tight">
            {mode() === "register" ? "Create your account" : "Welcome back"}
          </h1>
          <p class="mt-1 text-sm text-muted">
            {mode() === "register"
              ? "Register on this provider. We'll generate a device key in your browser."
              : "Sign in to register this device with a fresh key."}
          </p>
        </div>
      </div>

      <div
        class="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2"
        data-testid="provider-badge"
      >
        <span class="h-2 w-2 rounded-full bg-success" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-ink">{props.info.host}</div>
          <div class="truncate text-xs text-faint">
            {props.info.name} · OFSCP v{props.info.protocolVersion}
          </div>
        </div>
        <button
          type="button"
          class="text-xs text-accent hover:text-accent-hi"
          onClick={switchProvider}
          data-testid="change-provider"
        >
          Change
        </button>
      </div>

      <div class="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1 text-sm">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 font-medium transition-colors"
          classList={{
            "bg-accent text-white": mode() === "register",
            "text-muted hover:text-ink": mode() !== "register",
          }}
          onClick={() => setMode("register")}
          data-testid="tab-register"
        >
          Register
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-1.5 font-medium transition-colors"
          classList={{
            "bg-accent text-white": mode() === "login",
            "text-muted hover:text-ink": mode() !== "login",
          }}
          onClick={() => setMode("login")}
          data-testid="tab-login"
        >
          Sign in
        </button>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-muted">Handle</span>
        <div class="flex items-stretch rounded-lg border border-border bg-surface-2 focus-within:border-accent">
          <input
            class="w-full bg-transparent px-3 py-2 text-sm text-ink placeholder:text-faint outline-none"
            name="handle"
            autocomplete="username"
            placeholder="alice"
            value={handle()}
            onInput={(e) => setHandle(e.currentTarget.value)}
            disabled={busy()}
          />
          <span class="grid place-items-center px-3 text-xs text-faint font-mono">
            @{props.info.host}
          </span>
        </div>
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-muted">Password</span>
        <input
          class="input"
          type="password"
          name="password"
          autocomplete={mode() === "register" ? "new-password" : "current-password"}
          placeholder={mode() === "register" ? "At least 8 characters" : "Your password"}
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          disabled={busy()}
        />
      </label>

      <Show when={mode() === "register"}>
        <label class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-muted">
            Recovery email <span class="text-faint">(optional)</span>
          </span>
          <input
            class="input"
            type="email"
            name="recoveryEmail"
            autocomplete="email"
            placeholder="you@example.com"
            value={recoveryEmail()}
            onInput={(e) => setRecoveryEmail(e.currentTarget.value)}
            disabled={busy()}
          />
        </label>
      </Show>

      <Show when={error()}>
        <p class="text-sm text-danger" role="alert" data-testid="auth-error">
          {error()}
        </p>
      </Show>

      <button type="submit" class="btn-accent" disabled={busy()} data-testid="auth-submit">
        <Switch>
          <Match when={busy()}>Working…</Match>
          <Match when={mode() === "register"}>Create account</Match>
          <Match when={mode() === "login"}>Sign in</Match>
        </Switch>
      </button>

      <p class="text-center text-xs text-faint">
        Your private device key is generated and stored only on this device.
      </p>
    </form>
  );
};
