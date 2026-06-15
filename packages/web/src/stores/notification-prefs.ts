/**
 * Server-backed per-channel / per-group notification preferences (distinct from
 * the device-local `notify-prefs` chime/badge toggles). Holds the caller's
 * stored preferences keyed by a `scopeType:scopeId` composite, so a channel and a
 * group can never collide.
 *
 * The effective mode for a (channel, group) resolves channel pref → group pref →
 * default `mentions` ({@link effectiveModeFor}), mirroring the server's
 * resolution. Mutations are optimistic (the store updates first, then the
 * PUT/DELETE reconciles).
 *
 *  - {@link hydrateNotificationPrefs} pulls the prefs on session start.
 *  - {@link setPref} upserts (mode → PUT) optimistically.
 *  - {@link clearPref} removes the row (→ DELETE), reverting to inherited.
 *  - {@link clearNotificationPrefs} wipes the store on logout.
 */
import { createStore } from "solid-js/store";
import {
  type NotificationMode,
  type NotificationPref,
  type NotificationScopeType,
  clearNotificationPref,
  fetchNotificationPrefs,
  setNotificationPref,
} from "../lib/notification-settings-api.ts";
import { sessionClient } from "./session.ts";

export type { NotificationMode, NotificationScopeType };

/** The default effective mode when no channel/group preference exists. */
export const DEFAULT_NOTIFICATION_MODE: NotificationMode = "mentions";

interface PrefState {
  /** Keyed `scopeType:scopeId` → mode. */
  byScope: Record<string, NotificationMode>;
}

const [prefState, setPrefState] = createStore<PrefState>({ byScope: {} });

export { prefState };

/** The composite key for a scope (so channel + group ids never collide). */
function keyOf(scopeType: NotificationScopeType, scopeId: string): string {
  return `${scopeType}:${scopeId}`;
}

/** GET the prefs on session start and seed the store. */
export async function hydrateNotificationPrefs(): Promise<void> {
  const client = sessionClient();
  if (!client) return;
  try {
    const prefs = await fetchNotificationPrefs(client);
    const byScope: Record<string, NotificationMode> = {};
    for (const p of prefs) byScope[keyOf(p.scopeType, p.scopeId)] = p.mode;
    setPrefState("byScope", byScope);
  } catch {
    // Non-fatal: controls degrade to the inherited default.
  }
}

/** The explicit mode set for a scope, or undefined when inherited. */
export function modeFor(
  scopeType: NotificationScopeType,
  scopeId: string,
): NotificationMode | undefined {
  return prefState.byScope[keyOf(scopeType, scopeId)];
}

/**
 * The EFFECTIVE mode for a (channel, group): explicit channel pref → explicit
 * group pref → default `mentions`. Mirrors the server's resolution.
 */
export function effectiveModeFor(channelId: string, groupId: string): NotificationMode {
  return (
    prefState.byScope[keyOf("channel", channelId)] ??
    prefState.byScope[keyOf("group", groupId)] ??
    DEFAULT_NOTIFICATION_MODE
  );
}

/** Upsert a scope's mode optimistically, then PUT. */
export function setPref(
  scopeType: NotificationScopeType,
  scopeId: string,
  mode: NotificationMode,
): void {
  const key = keyOf(scopeType, scopeId);
  const prev = prefState.byScope[key];
  setPrefState("byScope", key, mode);
  const client = sessionClient();
  if (!client) return;
  void setNotificationPref(client, scopeType, scopeId, mode).catch(() => {
    // Revert on failure.
    if (prev === undefined) setPrefState("byScope", key, undefined as never);
    else setPrefState("byScope", key, prev);
  });
}

/** Clear a scope's explicit mode optimistically (revert to inherited), then DELETE. */
export function clearPref(scopeType: NotificationScopeType, scopeId: string): void {
  const key = keyOf(scopeType, scopeId);
  const prev = prefState.byScope[key];
  setPrefState("byScope", key, undefined as never);
  const client = sessionClient();
  if (!client) return;
  void clearNotificationPref(client, scopeType, scopeId).catch(() => {
    if (prev !== undefined) setPrefState("byScope", key, prev);
  });
}

/** Wipe all preference state (logout). */
export function clearNotificationPrefs(): void {
  setPrefState("byScope", {});
}

/** All explicitly-set preferences (for a settings list). */
export function allPrefs(): NotificationPref[] {
  return Object.entries(prefState.byScope).map(([key, mode]) => {
    const sep = key.indexOf(":");
    return {
      scopeType: key.slice(0, sep) as NotificationScopeType,
      scopeId: key.slice(sep + 1),
      mode,
    };
  });
}
