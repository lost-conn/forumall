/**
 * Auth & onboarding (P8, §4.1–§4.3) — the design's single "Welcome" card
 * (screenshot 08 / onboarding.jsx). The provider is auto-probed from the page
 * origin and shown at the foot of the card with a one-tap **Change**; tapping it
 * (or "sign up on another instance") reveals the server picker. Register / Sign
 * in toggle; on submit the controller runs bootstrap → in-browser keygen →
 * device-key → store and lands the user authenticated.
 */
import { type Component, Match, Show, Switch, createSignal, onMount } from "solid-js";
import { OfscpHttpError } from "../lib/ofscp-client.ts";
import {
  type ProviderInfo,
  defaultProviderHost,
  probeProvider,
  storeProviderHost,
} from "../lib/provider.ts";
import { doLogin, doRegister } from "../stores/auth-controller.ts";
import { brandIconUrl, brandName } from "../stores/branding.ts";
import { provider, setProvider } from "../stores/session.ts";
import { Icon } from "./Icon.tsx";

type Mode = "login" | "register";

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof OfscpHttpError) {
    const body = err.body as { detail?: string } | undefined;
    return body?.detail ?? `Request failed (${err.status}).`;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export const AuthScreen: Component = () => {
  const [changing, setChanging] = createSignal(false);
  const [probing, setProbing] = createSignal(false);

  // Auto-probe the origin's host so the welcome card can show its server inline
  // (with a Change affordance) instead of a separate connect step.
  onMount(async () => {
    if (provider()) return;
    setProbing(true);
    try {
      const host = defaultProviderHost();
      const info = await probeProvider(host);
      storeProviderHost(host);
      setProvider(info);
    } catch {
      /* origin isn't a provider — fall back to the picker */
    } finally {
      setProbing(false);
    }
  });

  return (
    <div class="grid min-h-screen place-items-center bg-canvas px-4">
      <div class="w-full max-w-sm">
        <Switch>
          <Match when={!changing() && provider()}>
            {(info) => <WelcomeCard info={info()} onChange={() => setChanging(true)} />}
          </Match>
          <Match when={probing() && !provider()}>
            <div class="text-center text-sm text-muted" data-testid="auth-probing">
              Connecting…
            </div>
          </Match>
          <Match when={true}>
            <ConnectStage onConnected={() => setChanging(false)} />
          </Match>
        </Switch>
      </div>
    </div>
  );
};

/** Brand header shown atop both stages. */
const Brand: Component<{ title: string; sub: string }> = (props) => (
  <div class="mb-6 flex flex-col items-center gap-3 text-center">
    <img
      src={brandIconUrl() ?? "/forumall-mark.svg"}
      alt={brandName()}
      class="h-12 w-12 rounded-md object-cover"
      width="48"
      height="48"
    />
    <div>
      <div class="font-display text-2xl font-bold tracking-tight text-ink">{props.title}</div>
      <div class="mt-0.5 text-sm text-muted">{props.sub}</div>
    </div>
  </div>
);

/** The single welcome / credentials card. */
const WelcomeCard: Component<{ info: ProviderInfo; onChange: () => void }> = (props) => {
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
    } catch (err) {
      setError(
        errorMessage(err, mode() === "register" ? "Registration failed." : "Sign-in failed."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="card-raised flex flex-col gap-4" onSubmit={submit} data-testid="credentials-form">
      <Brand
        title={mode() === "register" ? `Welcome to ${brandName()}` : "Welcome back"}
        sub={mode() === "register" ? "Pick a name and jump in." : "Sign in to your account."}
      />

      <div class="grid grid-cols-2 gap-1.5">
        <ModeTab
          active={mode() === "register"}
          onClick={() => setMode("register")}
          testid="tab-register"
        >
          Register
        </ModeTab>
        <ModeTab active={mode() === "login"} onClick={() => setMode("login")} testid="tab-login">
          Sign in
        </ModeTab>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Username</span>
        <div class="flex items-stretch rounded-md border-[1.5px] border-border-strong bg-surface-2 focus-within:(outline outline-2 outline-accent outline-offset-1)">
          <span class="grid place-items-center pl-3 text-faint">
            <Icon name="at" size={15} />
          </span>
          <input
            class="w-full bg-transparent px-2 py-2 text-sm text-ink outline-none placeholder:text-faint"
            name="handle"
            aria-label={`Handle @${props.info.host}`}
            autocomplete="username"
            placeholder="your_handle"
            value={handle()}
            onInput={(e) => setHandle(e.currentTarget.value)}
            disabled={busy()}
          />
          <span class="grid place-items-center px-3 font-mono text-xs text-faint">
            @{props.info.host}
          </span>
        </div>
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Password</span>
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
          <span class="eyebrow">Recovery email (optional)</span>
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

      <button
        type="submit"
        class="btn-accent justify-center py-2.5"
        disabled={busy()}
        data-testid="auth-submit"
      >
        <Switch>
          <Match when={busy()}>Working…</Match>
          <Match when={mode() === "register"}>Create account</Match>
          <Match when={mode() === "login"}>Sign in</Match>
        </Switch>
      </button>

      <div class="fa-divider fa-divider--dashed" />

      {/* Server row */}
      <div
        class="flex items-center gap-2.5 rounded-md border-[1.5px] border-border-strong bg-surface-2 px-3 py-2"
        data-testid="provider-badge"
      >
        <span class="text-accent">
          <Icon name="globe" size={16} />
        </span>
        <div class="min-w-0 flex-1 leading-tight">
          <div class="eyebrow">Home server</div>
          <div class="truncate font-mono text-[13px] text-ink">{props.info.host}</div>
        </div>
        <button
          type="button"
          class="btn-ghost px-3 py-1.5 text-xs"
          onClick={props.onChange}
          data-testid="change-provider"
        >
          Change
        </button>
      </div>
      <button
        type="button"
        class="text-center text-xs text-accent hover:underline"
        onClick={props.onChange}
      >
        or sign up on another instance ↗
      </button>
    </form>
  );
};

const ModeTab: Component<{
  active: boolean;
  onClick: () => void;
  testid: string;
  children: string;
}> = (props) => (
  <button
    type="button"
    class="rounded-md border-[1.5px] px-3 py-1.5 text-[11px] font-mono font-bold uppercase tracking-wide transition-colors"
    classList={{
      "border-accent bg-accent-soft text-accent": props.active,
      "border-border-strong text-muted hover:(bg-surface-2 text-ink)": !props.active,
    }}
    onClick={props.onClick}
    data-testid={props.testid}
  >
    {props.children}
  </button>
);

/** Server picker (shown on first run if origin isn't a provider, or via Change). */
const ConnectStage: Component<{ onConnected: () => void }> = (props) => {
  const [host, setHost] = createSignal(provider()?.host ?? defaultProviderHost());
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
      props.onConnected();
    } catch (err) {
      setError(errorMessage(err, "Could not reach that provider."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="card-raised flex flex-col gap-4" onSubmit={connect} data-testid="connect-form">
      <Brand title="Choose your provider" sub="The OFSCP instance that hosts your account." />
      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Provider domain</span>
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
      <button
        type="submit"
        class="btn-accent justify-center py-2.5"
        disabled={busy()}
        data-testid="connect-submit"
      >
        {busy() ? "Checking…" : "Continue"}
      </button>
    </form>
  );
};
