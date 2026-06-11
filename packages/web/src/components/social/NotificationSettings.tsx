/**
 * Notification settings — two device-local toggles that gate the in-page chime
 * and the out-of-app unread badges. Purely client-side, backed by localStorage
 * via the notify-prefs store (mirrors AppearanceSettings). Turning a pref off
 * takes effect immediately: the FX coordinator's reactive badge effect reflects
 * the badge pref, and the chime gate reads the sound pref on each event.
 */
import type { Component, JSX } from "solid-js";
import {
  badgeEnabled,
  setBadgeEnabled,
  setSoundEnabled,
  soundEnabled,
} from "../../stores/notify-prefs.ts";

/** A labelled on/off switch row matching the design's `fa-switch`. */
function ToggleRow(props: {
  testid: string;
  label: string;
  detail: string;
  checked: boolean;
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
        onClick={() => props.onToggle(!props.checked)}
        class="fa-switch"
        classList={{ "fa-switch--on": props.checked }}
      >
        <span class="fa-switch__knob" />
      </button>
    </div>
  );
}

export const NotificationSettings: Component = () => {
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
    </section>
  );
};
