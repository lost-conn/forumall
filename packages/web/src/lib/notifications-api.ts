/**
 * Inbound notifications-feed REST surface (a provider-local extension — distinct
 * from the §10 outbound notification webhooks).
 *
 *  - {@link fetchNotifications} — GET a newest-first page of the caller's
 *    notifications (optionally filtered to mentions or replies), plus the
 *    per-type unseen counts.
 *  - {@link markNotificationsSeen} / {@link markNotificationsRead} — POST to mark
 *    specific ids (or all, when ids is omitted) seen / read. Read implies seen.
 *
 * All go through the session's signing {@link OfscpClient} so each request
 * carries the §4.4 signature.
 */
import type { NotificationCounts, NotificationsResponse } from "@forumall/shared";
import type { OfscpClient } from "./ofscp-client.ts";

/** GET /api/me/notifications → a page of the caller's feed + unseen counts. */
export async function fetchNotifications(
  client: OfscpClient,
  opts: { type?: "mention" | "reply"; cursor?: string } = {},
): Promise<NotificationsResponse> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  const path = qs ? `/api/me/notifications?${qs}` : "/api/me/notifications";
  const res = await client.get<NotificationsResponse>(path);
  return res.data;
}

/** POST /api/me/notifications/seen → mark seen (omit ids to mark all). */
export async function markNotificationsSeen(
  client: OfscpClient,
  ids?: string[],
): Promise<NotificationCounts> {
  const body = ids && ids.length > 0 ? { ids } : {};
  const res = await client.post<{ affected: number; counts: NotificationCounts }>(
    "/api/me/notifications/seen",
    body,
  );
  return res.data.counts;
}

/** POST /api/me/notifications/read → mark read (omit ids to mark all). */
export async function markNotificationsRead(
  client: OfscpClient,
  ids?: string[],
): Promise<NotificationCounts> {
  const body = ids && ids.length > 0 ? { ids } : {};
  const res = await client.post<{ affected: number; counts: NotificationCounts }>(
    "/api/me/notifications/read",
    body,
  );
  return res.data.counts;
}
