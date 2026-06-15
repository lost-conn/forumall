/**
 * Per-channel / per-group notification-settings REST surface (a provider-local
 * extension — server-stored preferences, distinct from the device-local
 * `notify-prefs` toggles).
 *
 *  - {@link fetchNotificationPrefs} — GET the caller's stored preferences.
 *  - {@link setNotificationPref} — PUT (upsert) one preference.
 *  - {@link clearNotificationPref} — DELETE one preference (revert to inherited).
 *
 * All go through the session's signing {@link OfscpClient} so each request
 * carries the §4.4 signature.
 */
import type { OfscpClient } from "./ofscp-client.ts";

/** Notification mode for a scope. */
export type NotificationMode = "all" | "mentions" | "none";
/** The scope a preference applies to. */
export type NotificationScopeType = "group" | "channel";

/** One stored notification preference. */
export interface NotificationPref {
  readonly scopeType: NotificationScopeType;
  readonly scopeId: string;
  readonly mode: NotificationMode;
}

/** GET /api/me/notification-settings → the caller's stored preferences. */
export async function fetchNotificationPrefs(client: OfscpClient): Promise<NotificationPref[]> {
  const res = await client.get<{ prefs: NotificationPref[] }>("/api/me/notification-settings");
  return res.data.prefs ?? [];
}

/** PUT /api/me/notification-settings → upsert one preference; returns the row. */
export async function setNotificationPref(
  client: OfscpClient,
  scopeType: NotificationScopeType,
  scopeId: string,
  mode: NotificationMode,
): Promise<NotificationPref> {
  const res = await client.put<NotificationPref>("/api/me/notification-settings", {
    scopeType,
    scopeId,
    mode,
  });
  return res.data;
}

/** DELETE /api/me/notification-settings → clear one preference (inherit again). */
export async function clearNotificationPref(
  client: OfscpClient,
  scopeType: NotificationScopeType,
  scopeId: string,
): Promise<void> {
  const params = new URLSearchParams({ scopeType, scopeId });
  await client.delete(`/api/me/notification-settings?${params.toString()}`);
}
