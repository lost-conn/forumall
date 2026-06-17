/**
 * Notification preferences — two device-local, localStorage-backed booleans that
 * gate the in-page chime and the out-of-app unread badges. Both default ON.
 * Mirrors the read/persist pattern in `appearance.ts` (private-mode safe).
 *
 *  - `forumall.notify.sound` — play a chime for eligible incoming messages.
 *  - `forumall.notify.badge` — reflect total unread on the tab title / favicon /
 *    PWA app badge.
 *  - `forumall.notify.desktop` — raise an OS notification for DMs / mentions /
 *    replies that land while the tab is open but NOT focused (also gated on the
 *    granted Notification permission; a no-op without it).
 *
 * Exposed as reactive getters + setters so the settings UI and the FX coordinator
 * read one source of truth.
 */
import { createStore } from "solid-js/store";

interface NotifyPrefs {
  sound: boolean;
  badge: boolean;
  desktop: boolean;
}

const KEY = {
  sound: "forumall.notify.sound",
  badge: "forumall.notify.badge",
  desktop: "forumall.notify.desktop",
};

/** Read a boolean pref; defaults to `true` when unset or storage is unavailable. */
function readBool(key: string): boolean {
  try {
    const v = localStorage.getItem(key);
    // Absent → default ON; only the literal "false" turns it off.
    return v === null ? true : v !== "false";
  } catch {
    return true;
  }
}

function persist(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "true" : "false");
  } catch {
    /* private mode / disabled storage — in-memory only */
  }
}

const [notifyPrefs, setNotifyPrefs] = createStore<NotifyPrefs>({
  sound: readBool(KEY.sound),
  badge: readBool(KEY.badge),
  desktop: readBool(KEY.desktop),
});

export { notifyPrefs };

/** Reactive accessor: is the incoming-message chime enabled? */
export function soundEnabled(): boolean {
  return notifyPrefs.sound;
}

/** Reactive accessor: is unread badging (title/favicon/app-badge) enabled? */
export function badgeEnabled(): boolean {
  return notifyPrefs.badge;
}

/** Reactive accessor: are while-unfocused desktop notifications enabled? */
export function desktopEnabled(): boolean {
  return notifyPrefs.desktop;
}

export function setSoundEnabled(on: boolean): void {
  setNotifyPrefs("sound", on);
  persist(KEY.sound, on);
}

export function setBadgeEnabled(on: boolean): void {
  setNotifyPrefs("badge", on);
  persist(KEY.badge, on);
}

export function setDesktopEnabled(on: boolean): void {
  setNotifyPrefs("desktop", on);
  persist(KEY.desktop, on);
}
