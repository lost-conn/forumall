/**
 * Persistent guest banner — a single slim bar shown to a signed-in GUEST nudging
 * them to secure their account (§4.8). Unlike the push nudge this is NOT
 * dismissible: a guest account is temporary, so the prompt stays until the user
 * upgrades (claim / merge), at which point `session.isGuest` flips false and the
 * bar disappears. Routes to Settings, where {@link AccountUpgrade} lives.
 *
 * Self-gates on `session.isGuest`; the AppShell also guards on `session.actor`.
 */
import { useNavigate } from "@solidjs/router";
import { type Component, Show } from "solid-js";
import { session } from "../../stores/session.ts";
import { Icon } from "../Icon.tsx";

export const GuestUpgradeBanner: Component = () => {
  const navigate = useNavigate();
  return (
    <Show when={session.isGuest}>
      <section
        class="mx-3 mt-3 flex items-center gap-3 rounded-md border-[1.5px] border-accent bg-accent-soft px-3.5 py-2.5 md:mx-4"
        data-testid="guest-upgrade-banner"
        aria-label="Secure your guest account"
      >
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-md border-[1.5px] border-accent bg-surface text-accent">
          <Icon name="lock" size={16} />
        </span>
        <div class="min-w-0 flex-1">
          <div class="font-body text-[13.5px] font-semibold text-ink">
            You're browsing as a guest — secure your account
          </div>
          <div class="fa-meta mt-[2px]">
            Pick a permanent handle or log into an existing account so you don't lose access.
          </div>
        </div>
        <button
          type="button"
          class="btn-accent shrink-0 px-3 py-1.5 text-[11px]"
          data-testid="guest-upgrade-cta"
          onClick={() => navigate("/settings")}
        >
          Secure account
        </button>
      </section>
    </Show>
  );
};
