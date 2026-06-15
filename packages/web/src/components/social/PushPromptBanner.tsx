/**
 * First-load push nudge — a slim, dismissible inline banner shown to a signed-in
 * user who *could* enable Web Push but hasn't been asked yet. Web Push is fully
 * functional via Settings → Notifications, but nothing surfaces it; this gives a
 * quiet, one-time prompt.
 *
 * Visibility (computed once on mount via the pure {@link shouldShowPushPrompt}):
 * push supported + permission still `default` + not already enabled + not
 * previously dismissed on this device. It renders nothing otherwise, and never
 * nags: "Not now" persists a dismiss flag, and a failed/denied Enable also sets
 * it (so we don't loop).
 */
import type { Component } from "solid-js";
import { Show, createSignal, onMount } from "solid-js";
import {
  enablePush,
  isPushSupported,
  pushEnabledPref,
  pushPermission,
  pushPromptDismissed,
  setPushPromptDismissed,
  shouldShowPushPrompt,
} from "../../lib/push.ts";
import { sessionClient } from "../../stores/session.ts";
import { Icon } from "../Icon.tsx";

export const PushPromptBanner: Component = () => {
  const [visible, setVisible] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    setVisible(
      shouldShowPushPrompt({
        supported: isPushSupported(),
        permission: pushPermission(),
        enabledPref: pushEnabledPref(),
        dismissed: pushPromptDismissed(),
      }),
    );
  });

  /** Permanently dismiss on this device (never show again). */
  function dismiss(): void {
    setPushPromptDismissed(true);
    setVisible(false);
  }

  async function onEnable(): Promise<void> {
    const client = sessionClient();
    if (!client) {
      // No session yet — bail without nagging.
      setVisible(false);
      return;
    }
    setBusy(true);
    try {
      await enablePush(client);
      // Granted + subscribed — the nudge has served its purpose.
      setVisible(false);
    } catch {
      // Denied / unsupported / network error: hide and don't loop on reload.
      setPushPromptDismissed(true);
      setVisible(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={visible()}>
      <section
        class="mx-3 mt-3 flex items-center gap-3 rounded-md border-[1.5px] border-border-strong bg-surface-2 px-3.5 py-2.5 md:mx-4"
        data-testid="push-prompt-banner"
        aria-label="Enable push notifications"
      >
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-md border-[1.5px] border-border bg-accent-soft text-accent">
          <Icon name="bell" size={16} />
        </span>
        <div class="min-w-0 flex-1">
          <div class="font-body text-[13.5px] font-semibold text-ink">
            Get notified about mentions and replies
          </div>
          <div class="fa-meta mt-[2px]">
            Turn on push to hear about it even when Forumall is closed.
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="btn-ghost px-3 py-1.5 text-[11px]"
            data-testid="push-prompt-dismiss"
            onClick={dismiss}
          >
            Not now
          </button>
          <button
            type="button"
            class="btn-accent px-3 py-1.5 text-[11px]"
            data-testid="push-prompt-enable"
            disabled={busy()}
            onClick={() => void onEnable()}
          >
            {busy() ? "Enabling…" : "Enable"}
          </button>
        </div>
      </section>
    </Show>
  );
};
