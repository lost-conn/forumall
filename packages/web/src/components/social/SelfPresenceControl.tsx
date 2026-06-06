/**
 * Self-presence control (P8, §7.5 / §6.4). A compact availability picker shown in
 * the app nav: the caller sets `online` / `away` / `dnd` and an optional status
 * message, issued over the WS `presence.set` (= `PUT /api/me/presence`). `offline`
 * is connection-derived and never settable here.
 *
 * The control reflects the caller's own explicit presence from the store's `self`
 * entry (set optimistically on `presence.set`), so it updates instantly; other
 * viewers see the privacy-filtered fan-out the server emits.
 */
import { type Component, For, Show, createSignal } from "solid-js";
import type { SettableAvailability } from "../../lib/social-api.ts";
import { setMyPresence } from "../../stores/presence-controller.ts";
import { presence } from "../../stores/presence.ts";
import { sessionWs } from "../../stores/session.ts";

interface PresenceOption {
  value: SettableAvailability;
  label: string;
  dot: string;
}

const ONLINE_OPTION: PresenceOption = { value: "online", label: "Online", dot: "bg-success" };
const OPTIONS: PresenceOption[] = [
  ONLINE_OPTION,
  { value: "away", label: "Away", dot: "bg-amber-400" },
  { value: "dnd", label: "Do not disturb", dot: "bg-danger" },
];

export const SelfPresenceControl: Component = () => {
  const [open, setOpen] = createSignal(false);
  const current = () => presence.self.availability;
  const currentOption = (): PresenceOption =>
    OPTIONS.find((o) => o.value === current()) ?? ONLINE_OPTION;
  const [status, setStatus] = createSignal(presence.self.status ?? "");

  const choose = (availability: SettableAvailability): void => {
    setMyPresence(sessionWs(), availability, status().trim() || undefined);
  };

  const saveStatus = (): void => {
    setMyPresence(sessionWs(), current(), status().trim() || undefined);
  };

  return (
    <div class="relative px-2 pb-1" data-testid="self-presence">
      <button
        type="button"
        class="badge w-full justify-start gap-2"
        onClick={() => setOpen((v) => !v)}
        data-testid="self-presence-toggle"
        data-availability={current()}
      >
        <span class={`h-2 w-2 shrink-0 rounded-full ${currentOption().dot}`} />
        <span class="truncate">{currentOption().label}</span>
        <Show when={presence.self.status}>
          <span class="truncate text-faint">· {presence.self.status}</span>
        </Show>
      </button>

      <Show when={open()}>
        <div
          class="absolute bottom-full left-2 right-2 z-50 mb-1 rounded-lg border border-border bg-surface p-2 shadow-lg"
          data-testid="self-presence-menu"
        >
          <ul class="flex flex-col gap-0.5">
            <For each={OPTIONS}>
              {(opt) => (
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:(bg-surface-2 text-ink)"
                    classList={{ "bg-surface-2 text-ink": current() === opt.value }}
                    onClick={() => choose(opt.value)}
                    data-testid={`set-presence-${opt.value}`}
                  >
                    <span class={`h-2 w-2 shrink-0 rounded-full ${opt.dot}`} />
                    <span>{opt.label}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <div class="mt-2 flex gap-1.5 border-t border-border pt-2">
            <input
              class="input flex-1 px-2 py-1 text-xs"
              placeholder="Status message"
              value={status()}
              onInput={(e) => setStatus(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveStatus();
                }
              }}
              data-testid="self-presence-status-input"
            />
            <button
              type="button"
              class="btn-ghost px-2 py-1 text-xs"
              onClick={saveStatus}
              data-testid="self-presence-status-save"
            >
              Save
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
};
