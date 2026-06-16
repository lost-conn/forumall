/**
 * Guest account upgrade (§4.8) — secure a provisional guest account two ways:
 *
 *   - **Create a permanent account** (claim): pick a new handle + password →
 *     `POST /api/me/claim`. The guest becomes a brand-new full account.
 *   - **Log into an existing account** (merge): supply that account's handle +
 *     password → `POST /api/me/merge`. The guest's activity folds in and the
 *     guest identity goes away.
 *
 * Both rebind THIS device's key to the new/target actor (same keyId), so after
 * either path {@link applyUpgradedIdentity} persists the new session + reloads to
 * re-bootstrap cleanly as the new actor — the device stays logged in, no key
 * loss. Surfaces server errors (409 handle taken / 400 invalid / 401 wrong
 * credentials) inline. Visible only to a guest (the caller gates on isGuest).
 */
import { type Component, Match, Show, Switch, createSignal } from "solid-js";
import {
  applyUpgradedIdentity,
  claimAccount,
  mergeIntoAccount,
  validateClaimForm,
} from "../../lib/account-upgrade.ts";
import { OfscpHttpError } from "../../lib/ofscp-client.ts";
import { sessionClient } from "../../stores/session.ts";
import { Icon } from "../Icon.tsx";

type Mode = "claim" | "merge";

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof OfscpHttpError) {
    const body = err.body as { detail?: string } | undefined;
    return body?.detail ?? `Request failed (${err.status}).`;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export const AccountUpgrade: Component = () => {
  const [mode, setMode] = createSignal<Mode>("claim");

  return (
    <div data-testid="account-upgrade">
      <div class="card mb-5 flex items-start gap-[14px] border-accent bg-accent-soft/40">
        <span class="text-accent">
          <Icon name="lock" size={20} />
        </span>
        <div class="flex-1">
          <div class="font-display text-sm font-bold tracking-tight text-ink">
            You're browsing as a guest
          </div>
          <p class="fa-meta mt-1">
            Guest accounts are temporary and can't be used to sign in elsewhere. Secure your account
            to keep your activity and sign in from any device.
          </p>
        </div>
      </div>

      <div class="mb-5 grid grid-cols-2 gap-1.5">
        <ModeTab
          active={mode() === "claim"}
          onClick={() => setMode("claim")}
          testid="upgrade-tab-claim"
        >
          Create a permanent account
        </ModeTab>
        <ModeTab
          active={mode() === "merge"}
          onClick={() => setMode("merge")}
          testid="upgrade-tab-merge"
        >
          Log into an existing account
        </ModeTab>
      </div>

      <Switch>
        <Match when={mode() === "claim"}>
          <ClaimForm />
        </Match>
        <Match when={mode() === "merge"}>
          <MergeForm />
        </Match>
      </Switch>
    </div>
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
    class="rounded-md border-[1.5px] px-3 py-2 text-center text-[11px] font-mono font-bold uppercase tracking-wide leading-tight transition-colors"
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

/** Claim — become a NEW full account. */
const ClaimForm: Component = () => {
  const [handle, setHandle] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    const h = handle().trim().toLowerCase();
    const invalid = validateClaimForm({
      handle: h,
      password: password(),
      confirmPassword: confirm(),
    });
    if (invalid) {
      setError(invalid);
      return;
    }
    const client = sessionClient();
    if (!client) {
      setError("Not signed in.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await claimAccount(client, {
        handle: h,
        password: password(),
        ...(displayName().trim() ? { displayName: displayName().trim() } : {}),
      });
      // Persist the new identity + reload to re-bootstrap as the new actor.
      applyUpgradedIdentity(result);
    } catch (err) {
      setError(errorMessage(err, "Could not create your account."));
      setBusy(false);
    }
  };

  return (
    <form class="card flex flex-col gap-4" onSubmit={submit} data-testid="claim-form">
      <p class="text-sm text-muted">
        Pick a permanent handle and a password. Your current activity stays with you.
      </p>

      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Username</span>
        <input
          class="input"
          name="handle"
          autocomplete="username"
          placeholder="your_handle"
          value={handle()}
          onInput={(e) => setHandle(e.currentTarget.value)}
          disabled={busy()}
          data-testid="claim-handle"
        />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Display name (optional)</span>
        <input
          class="input"
          name="displayName"
          placeholder="How others see you"
          value={displayName()}
          onInput={(e) => setDisplayName(e.currentTarget.value)}
          disabled={busy()}
          data-testid="claim-display-name"
        />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Password</span>
        <input
          class="input"
          type="password"
          name="password"
          autocomplete="new-password"
          placeholder="At least 8 characters"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          disabled={busy()}
          data-testid="claim-password"
        />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Confirm password</span>
        <input
          class="input"
          type="password"
          name="confirmPassword"
          autocomplete="new-password"
          placeholder="Re-enter your password"
          value={confirm()}
          onInput={(e) => setConfirm(e.currentTarget.value)}
          disabled={busy()}
          data-testid="claim-confirm-password"
        />
      </label>

      <Show when={error()}>
        <p class="text-sm text-danger" role="alert" data-testid="claim-error">
          {error()}
        </p>
      </Show>

      <button
        type="submit"
        class="btn-accent justify-center py-2.5"
        disabled={busy()}
        data-testid="claim-submit"
      >
        {busy() ? "Creating…" : "Create permanent account"}
      </button>
    </form>
  );
};

/** Merge — fold into an EXISTING account. */
const MergeForm: Component = () => {
  const [handle, setHandle] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    const h = handle().trim().toLowerCase();
    if (!h || !password()) {
      setError("Handle and password are required.");
      return;
    }
    const client = sessionClient();
    if (!client) {
      setError("Not signed in.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await mergeIntoAccount(client, { handle: h, password: password() });
      applyUpgradedIdentity(result);
    } catch (err) {
      setError(errorMessage(err, "Could not log into that account."));
      setBusy(false);
    }
  };

  return (
    <form class="card flex flex-col gap-4" onSubmit={submit} data-testid="merge-form">
      <div
        class="flex items-start gap-2.5 rounded-md border-[1.5px] border-danger/50 bg-danger/5 px-3 py-2.5"
        data-testid="merge-warning"
      >
        <span class="mt-0.5 text-danger">
          <Icon name="lock" size={15} />
        </span>
        <p class="text-[13px] text-ink">
          This <span class="font-semibold">merges</span> your current guest activity into the
          account below, then your guest identity goes away. This can't be undone.
        </p>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Existing username</span>
        <input
          class="input"
          name="handle"
          autocomplete="username"
          placeholder="your_handle"
          value={handle()}
          onInput={(e) => setHandle(e.currentTarget.value)}
          disabled={busy()}
          data-testid="merge-handle"
        />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="eyebrow">Password</span>
        <input
          class="input"
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="Your password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          disabled={busy()}
          data-testid="merge-password"
        />
      </label>

      <Show when={error()}>
        <p class="text-sm text-danger" role="alert" data-testid="merge-error">
          {error()}
        </p>
      </Show>

      <button
        type="submit"
        class="btn-accent justify-center py-2.5"
        disabled={busy()}
        data-testid="merge-submit"
      >
        {busy() ? "Merging…" : "Log in & merge"}
      </button>
    </form>
  );
};
