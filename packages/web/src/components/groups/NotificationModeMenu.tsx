/**
 * A small bell/mute control + dropdown for choosing a scope's notification mode
 * (All / Mentions only / Muted) plus a "Use … default" clear option. Reused for
 * both a channel row (with a group fallback) and the space-header group menu.
 *
 * It reads the EFFECTIVE mode from the server-backed `notification-prefs` store
 * and writes through `setPref`/`clearPref` (optimistic). The bell icon reflects
 * the effective mode at a glance (filled bell = all, plain bell = mentions, muted
 * bell = none).
 */
import { type Component, For, Show, createSignal } from "solid-js";
import {
  type NotificationMode,
  type NotificationScopeType,
  clearPref,
  effectiveModeFor,
  modeFor,
  setPref,
} from "../../stores/notification-prefs.ts";
import { Icon, type IconName } from "../Icon.tsx";

/** The pickable modes + their labels. */
const MODE_OPTIONS: ReadonlyArray<{ mode: NotificationMode; label: string; hint: string }> = [
  { mode: "all", label: "All messages", hint: "Notify on every message" },
  { mode: "mentions", label: "Mentions only", hint: "Only @mentions and replies" },
  { mode: "none", label: "Muted", hint: "Notify on nothing" },
];

/** The bell glyph + tint for an effective mode. */
function bellIcon(mode: NotificationMode): { icon: IconName; class: string; title: string } {
  if (mode === "none") return { icon: "bell", class: "text-faint", title: "Muted" };
  if (mode === "all") return { icon: "bell", class: "text-accent", title: "All messages" };
  return { icon: "bell", class: "text-muted", title: "Mentions only" };
}

export const NotificationModeMenu: Component<{
  scopeType: NotificationScopeType;
  scopeId: string;
  /** For a channel scope, its group id (so the "effective" fallback can resolve). */
  groupId?: string;
  /** Extra classes for the trigger button. */
  class?: string;
  /** Compact (icon-only) trigger for tight rows. */
  compact?: boolean;
}> = (props) => {
  const [open, setOpen] = createSignal(false);

  // Effective mode: for a channel, channel→group→default; for a group, the
  // group's own pref or default.
  const effective = (): NotificationMode =>
    props.scopeType === "channel"
      ? effectiveModeFor(props.scopeId, props.groupId ?? "")
      : (modeFor("group", props.scopeId) ?? "mentions");

  // Whether this exact scope has its own explicit pref (so "clear" is meaningful).
  const hasOwnPref = (): boolean => modeFor(props.scopeType, props.scopeId) !== undefined;

  const clearLabel = (): string =>
    props.scopeType === "channel" ? "Use group default" : "Use default (Mentions only)";

  const choose = (mode: NotificationMode): void => {
    setPref(props.scopeType, props.scopeId, mode);
    setOpen(false);
  };
  const doClear = (): void => {
    clearPref(props.scopeType, props.scopeId);
    setOpen(false);
  };

  return (
    <div class="relative">
      <button
        type="button"
        class={props.class ?? "text-faint hover:text-ink"}
        classList={{ [bellIcon(effective()).class]: true }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        data-testid="notif-mode-toggle"
        data-mode={effective()}
        aria-label="Notification settings"
        title={`Notifications: ${bellIcon(effective()).title}`}
      >
        <Icon name={bellIcon(effective()).icon} size={props.compact ? 13 : 15} />
        <Show when={effective() === "none"}>
          <span class="ml-0.5 align-middle text-[9px]">·muted</span>
        </Show>
      </button>

      <Show when={open()}>
        <button
          type="button"
          class="fixed inset-0 z-40 cursor-default"
          aria-label="Close menu"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        />
        <div
          class="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-md border-[1.5px] border-border-strong bg-surface shadow-[3px_3px_0_var(--shadow-col)]"
          data-testid="notif-mode-menu"
        >
          <div class="eyebrow px-3 pb-1 pt-2">Notifications</div>
          <For each={MODE_OPTIONS}>
            {(opt) => (
              <button
                type="button"
                class="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
                classList={{
                  "bg-accent-soft": modeFor(props.scopeType, props.scopeId) === opt.mode,
                }}
                data-testid={`notif-mode-${opt.mode}`}
                onClick={(e) => {
                  e.stopPropagation();
                  choose(opt.mode);
                }}
              >
                <span class="mt-0.5 text-muted">
                  <Icon
                    name={modeFor(props.scopeType, props.scopeId) === opt.mode ? "check" : "bell"}
                    size={13}
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block font-body text-[13px] text-ink">{opt.label}</span>
                  <span class="block font-mono text-[10px] text-faint">{opt.hint}</span>
                </span>
              </button>
            )}
          </For>
          <Show when={hasOwnPref()}>
            <button
              type="button"
              class="flex w-full items-center gap-2 border-t border-dashed border-border px-3 py-2 text-left font-mono text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              data-testid="notif-mode-clear"
              onClick={(e) => {
                e.stopPropagation();
                doClear();
              }}
            >
              <Icon name="x" size={12} />
              {clearLabel()}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
};
