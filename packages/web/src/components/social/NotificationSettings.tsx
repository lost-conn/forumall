/**
 * Notification settings — device-local toggles. The chime + unread badges are
 * pure client prefs (localStorage, via the notify-prefs store). The third toggle,
 * "Push notifications", enrols THIS device for real Web Push: it requests
 * Notification permission, subscribes via the service worker's PushManager, and
 * registers the subscription with the provider (all signed). It is disabled with
 * a hint when push is unsupported (e.g. the Vite dev server, where the SW does
 * not register) or permission has been denied.
 */
import { useQuery } from "@tanstack/solid-query";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal, onMount } from "solid-js";
import {
  disablePush,
  enablePush,
  isPushSupported,
  pushEnabledPref,
  pushPermission,
} from "../../lib/push.ts";
import {
  type NotificationMode,
  clearPref,
  effectiveModeFor,
  modeFor,
  setPref,
} from "../../stores/notification-prefs.ts";
import {
  badgeEnabled,
  desktopEnabled,
  setBadgeEnabled,
  setDesktopEnabled,
  setSoundEnabled,
  soundEnabled,
} from "../../stores/notify-prefs.ts";
import { sessionClient } from "../../stores/session.ts";
import { channelsQuery, myGroupsQuery } from "../groups/queries.ts";

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

  const desktopDetail = (): string => {
    if (!supported) return "Not available on this device or in development.";
    if (denied()) return "Blocked — allow notifications in your browser settings to enable.";
    return "Show a notification when a message arrives while this tab is open but not focused.";
  };

  // Desktop alerts ride on the granted Notification permission (the same one the
  // push toggle requests). Turning this on while permission is still un-asked
  // prompts for it directly, so it works without enrolling in Web Push.
  async function toggleDesktop(on: boolean): Promise<void> {
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore — the pref still flips; it's simply a no-op until granted */
      }
      setDenied(pushPermission() === "denied");
    }
    setDesktopEnabled(on);
  }

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
    <>
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
          testid="notify-desktop-toggle"
          label="Desktop alerts when away"
          detail={desktopDetail()}
          checked={desktopEnabled()}
          disabled={!supported || denied()}
          onToggle={(on) => void toggleDesktop(on)}
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
      <ChannelGroupNotificationSettings />
    </>
  );
};

/** The pickable modes + labels for the per-scope segmented control. */
const SCOPE_MODES: ReadonlyArray<{ mode: NotificationMode; label: string }> = [
  { mode: "all", label: "All" },
  { mode: "mentions", label: "Mentions" },
  { mode: "none", label: "Muted" },
];

/**
 * A small segmented mode picker for one scope (group or channel). It writes the
 * server-backed pref; `inherited` lets a channel offer an explicit "Inherit"
 * state (revert to the group default).
 */
function ModePicker(props: {
  scopeType: "group" | "channel";
  scopeId: string;
  inheritedLabel?: string;
}): JSX.Element {
  const explicit = (): NotificationMode | undefined => modeFor(props.scopeType, props.scopeId);
  return (
    <div
      class="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5"
      data-testid={`mode-picker-${props.scopeId}`}
    >
      <For each={SCOPE_MODES}>
        {(opt) => (
          <button
            type="button"
            class="rounded-[5px] px-2 py-1 font-mono text-[11px] transition-colors"
            classList={{
              "bg-accent-soft text-accent": explicit() === opt.mode,
              "text-muted hover:text-ink": explicit() !== opt.mode,
            }}
            data-testid={`mode-${props.scopeId}-${opt.mode}`}
            onClick={() => setPref(props.scopeType, props.scopeId, opt.mode)}
          >
            {opt.label}
          </button>
        )}
      </For>
      <Show when={props.inheritedLabel}>
        <button
          type="button"
          class="rounded-[5px] px-2 py-1 font-mono text-[11px] transition-colors"
          classList={{
            "bg-accent-soft text-accent": explicit() === undefined,
            "text-muted hover:text-ink": explicit() !== undefined,
          }}
          data-testid={`mode-${props.scopeId}-inherit`}
          onClick={() => clearPref(props.scopeType, props.scopeId)}
          title={props.inheritedLabel}
        >
          Inherit
        </button>
      </Show>
    </div>
  );
}

/** A group row with its channels, each with a mode picker. */
const GroupNotifRow: Component<{ groupId: string; name: string }> = (props) => {
  const channels = useQuery(() => channelsQuery(() => props.groupId));
  const textChannels = () => (channels.data ?? []).filter((c) => c.type === "text");
  return (
    <div
      class="border-b border-dashed border-border py-3 last:border-b-0"
      data-testid="notif-group-row"
    >
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="truncate font-body text-[13.5px] font-semibold text-ink">{props.name}</div>
          <div class="fa-meta mt-[3px]">Whole group default</div>
        </div>
        <ModePicker scopeType="group" scopeId={props.groupId} />
      </div>
      <Show when={textChannels().length > 0}>
        <ul class="mt-2 flex flex-col gap-1.5 border-l border-border pl-3">
          <For each={textChannels()}>
            {(ch) => (
              <li class="flex items-center gap-3" data-testid="notif-channel-row">
                <div class="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
                  #{ch.name ?? ch.id}
                  <span class="ml-1.5 text-[10px] text-faint">
                    ({effectiveModeFor(ch.id, props.groupId)})
                  </span>
                </div>
                <ModePicker
                  scopeType="channel"
                  scopeId={ch.id}
                  inheritedLabel="Use group default"
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
};

/** The "Channels & Groups" server-backed notification preferences section. */
const ChannelGroupNotificationSettings: Component = () => {
  const groups = useQuery(myGroupsQuery);
  return (
    <section class="card flex flex-col gap-1" data-testid="notification-scope-settings">
      <div class="mb-1">
        <h2 class="font-display text-sm font-bold tracking-tight">Channels &amp; groups</h2>
        <p class="mt-0.5 text-xs text-muted">
          Choose what each space notifies you about. Synced across your devices.
        </p>
      </div>
      <Show
        when={(groups.data ?? []).length > 0}
        fallback={
          <p class="py-3 text-xs text-faint" data-testid="notif-scope-empty">
            Join a group to set per-channel notifications.
          </p>
        }
      >
        <For each={groups.data ?? []}>
          {(grp) => <GroupNotifRow groupId={grp.id} name={grp.name} />}
        </For>
      </Show>
    </section>
  );
};
