/**
 * Active-thread + app-focus signals — tiny module state shared by the notify-fx
 * coordinator (sound suppression) and set by the chat / DM views.
 *
 * "Active thread" is the conversation the user currently has OPEN on screen:
 *  - `{ kind: "channel", id: channelId }` while a `ChatView` is mounted, or
 *  - `{ kind: "dm", id: dmId }` while a DM `ThreadView` is mounted.
 * It is cleared (`null`) when neither is open. The views call
 * {@link setActiveThread} / {@link clearActiveThread} from an effect/cleanup.
 *
 * "App focus" tracks whether the tab is visible AND the window is focused, so the
 * FX coordinator can suppress a chime for a message the user can already see land
 * (focused + watching the active thread). The tracker is installed once
 * ({@link installFocusTracker}) and is SSR-safe (guards `typeof document`).
 */
import { createSignal } from "solid-js";

/** The thread the user currently has open, or null. */
export interface ActiveThread {
  kind: "channel" | "dm";
  id: string;
}

const [activeThread, setActiveThreadSignal] = createSignal<ActiveThread | null>(null);

export { activeThread };

/** Mark the open thread (called by ChatView / DM ThreadView on mount/change). */
export function setActiveThread(kind: "channel" | "dm", id: string): void {
  setActiveThreadSignal({ kind, id });
}

/** Clear the open thread (called on unmount). */
export function clearActiveThread(): void {
  setActiveThreadSignal(null);
}

/** Does the active thread match this kind + id? Pure helper used for suppression. */
export function isActiveThread(kind: "channel" | "dm", id: string): boolean {
  const t = activeThread();
  return t !== null && t.kind === kind && t.id === id;
}

// --- App focus --------------------------------------------------------------

const [appFocused, setAppFocused] = createSignal(initialFocus());

/** Reactive accessor: is the tab visible AND the window focused right now? */
export function isAppFocused(): boolean {
  return appFocused();
}

function initialFocus(): boolean {
  if (typeof document === "undefined") return true;
  try {
    return document.visibilityState !== "hidden" && document.hasFocus();
  } catch {
    return true;
  }
}

let focusInstalled = false;

/**
 * Install the window focus / visibility tracker (idempotent, SSR-safe). Wired
 * once at boot from {@link installNotifyFx}.
 */
export function installFocusTracker(): void {
  if (focusInstalled) return;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  focusInstalled = true;
  const recompute = (): void => {
    setAppFocused(initialFocus());
  };
  document.addEventListener("visibilitychange", recompute);
  window.addEventListener("focus", recompute);
  window.addEventListener("blur", recompute);
  recompute();
}
