/**
 * Notification settings — device-local toggles. The chime + unread badges are
 * pure client prefs (localStorage, via the notify-prefs store). The third toggle,
 * "Push notifications", enrols THIS device for real Web Push: it requests
 * Notification permission, subscribes via the service worker's PushManager, and
 * registers the subscription with the provider (all signed). It is disabled with
 * a hint when push is unsupported (e.g. the Vite dev server, where the SW does
 * not register) or permission has been denied.
 */
import type { Component, JSX } from "solid-js";
import { createSignal, onMount } from "solid-js";
import {
  disablePush,
  enablePush,
  isPushSupported,
  pushEnabledPref,
  pushPermission,
} from "../../lib/push.ts";
import {
  badgeEnabled,
  setBadgeEnabled,
  setSoundEnabled,
  soundEnabled,
} from "../../stores/notify-prefs.ts";
import { sessionClient } from "../../stores/session.ts";

/** A labelled on/off switch row matching the design's `fa-switch`. */
function ToggleRow(props: {
  testid: string;
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <div class="flex items-center gap-3 border-b border-dashed border-border py-3 last:border-b-0">
      <div class="flex-1">
        <div class="font-body text-[13.5px] text-ink">{props.label}</div>
        <div class="fa-meta mt-[3px]">{props.detail}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        data-testid={props.testid}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => !props.disabled && props.onToggle(!props.checked)}
        class="fa-switch"
        classList={{
          "fa-switch--on": props.checked,
          "opacity-50 cursor-not-allowed": props.disabled,
        }}
      >
        <span class="fa-switch__knob" />
      </button>
    </div>
  );
}

export const NotificationSettings: Component = () => {
  const [pushOn, setPushOn] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // Capability + permission are read once on mount (they don't change reactively).
  const supported = isPushSupported();
  const [denied, setDenied] = createSignal(false);

  onMount(() => {
    setDenied(pushPermission() === "denied");
    setPushOn(pushEnabledPref());
  });

  const pushDisabled = (): boolean => !supported || denied() || busy();

  const pushDetail = (): string => {
    if (!supported) return "Not available on this device or in development.";
    if (denied()) return "Blocked — allow notifications in your browser settings to enable.";
    return "Get notified on this device when the app is closed.";
  };

  async function togglePush(on: boolean): Promise<void> {
    const client = sessionClient();
    if (!client) return;
    setBusy(true);
    // Optimistic, but reconcile to the true outcome.
    setPushOn(on);
    try {
      if (on) {
        await enablePush(client);
        setPushOn(true);
      } else {
        await disablePush(client);
        setPushOn(false);
      }
    } catch {
      // Revert on failure; reflect a fresh denied state if the user blocked it.
      setPushOn(pushEnabledPref());
      setDenied(pushPermission() === "denied");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="card flex flex-col gap-1" data-testid="notification-settings">
      <div class="mb-1">
        <h2 class="font-display text-sm font-bold tracking-tight">Notifications</h2>
        <p class="mt-0.5 text-xs text-muted">
          Sounds and unread badges. Stored on this device only.
        </p>
      </div>
      <ToggleRow
        testid="notify-sound-toggle"
        label="Notification sounds"
        detail="Play a soft chime for new direct messages, mentions, and replies."
        checked={soundEnabled()}
        onToggle={setSoundEnabled}
      />
      <ToggleRow
        testid="notify-badge-toggle"
        label="Unread badges"
        detail="Show your unread count on the tab title, favicon, and app icon."
        checked={badgeEnabled()}
        onToggle={setBadgeEnabled}
      />
      <ToggleRow
        testid="notify-push-toggle"
        label="Push notifications"
        detail={pushDetail()}
        checked={pushOn()}
        disabled={pushDisabled()}
        onToggle={(on) => void togglePush(on)}
      />
    </section>
  );
};
