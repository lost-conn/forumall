/**
 * Notifications-feed store (inbound @mentions + thread-replies — a provider-local
 * extension, distinct from the §10 outbound webhooks).
 *
 * Holds the caller's notification list (filterable by type) plus the per-type
 * unseen counts that drive the Inbox tab badges. The store is the single source
 * of truth for the Mentions / Thread-replies tabs.
 *
 *  - {@link hydrateNotifications} pulls the feed on session start / reconnect.
 *  - {@link applyNotificationCreated} folds an inbound `notification.created` WS
 *    event (a live mention/reply) into the store.
 *  - {@link markSeenLocal} / {@link markReadLocal} optimistically stamp state and
 *    POST the server (seen ≠ read; read implies seen).
 *  - {@link installNotificationListener} wires the single `notification.created`
 *    listener onto the home WS client (idempotent) + re-hydrates on reconnect,
 *    mirroring the read-marker controller.
 */
import type { Notification, NotificationCounts } from "@forumall/shared";
import { createStore } from "solid-js/store";
import {
  fetchNotifications,
  markNotificationsRead,
  markNotificationsSeen,
} from "../lib/notifications-api.ts";
import type { OfscpWsClient } from "../lib/ofscp-ws.ts";
import { sessionClient } from "./session.ts";

interface NotificationState {
  /** All loaded notifications, newest-first. */
  items: Notification[];
  /** Per-type unseen counts (badge basis). */
  counts: NotificationCounts;
}

const [notifState, setNotifState] = createStore<NotificationState>({
  items: [],
  counts: { mention: 0, reply: 0, message: 0 },
});

export { notifState };

/** Notifications of a given type (or all), newest-first. */
export function notificationsFor(type?: "mention" | "reply" | "message"): Notification[] {
  if (!type) return notifState.items;
  return notifState.items.filter((n) => n.type === type);
}

/** Unseen count for a type (badge). */
export function unseenCountFor(type: "mention" | "reply" | "message"): number {
  return notifState.counts[type] ?? 0;
}

/** GET the feed on session start and seed the store. */
export async function hydrateNotifications(): Promise<void> {
  const client = sessionClient();
  if (!client) return;
  try {
    const res = await fetchNotifications(client);
    setNotifState({ items: res.items, counts: res.counts });
  } catch {
    // Non-fatal: the tabs degrade gracefully without the feed.
  }
}

/** Fold an inbound `notification.created` event into the store (newest-first). */
export function applyNotificationCreated(notification: Notification): void {
  // Dedupe by id (the event is at-least-once; a reconnect re-hydrate may overlap).
  if (notifState.items.some((n) => n.id === notification.id)) return;
  setNotifState("items", (prev) => [notification, ...prev]);
  // A freshly-created notification is unseen → bump the badge for its type.
  if (
    notification.type === "mention" ||
    notification.type === "reply" ||
    notification.type === "message"
  ) {
    setNotifState("counts", notification.type, (c) => (c ?? 0) + 1);
  }
}

/**
 * Optimistically mark notifications SEEN, then POST. `ids` omitted marks every
 * loaded notification (and zeroes all counts). Stamps a local `seenAt` so the
 * badge clears immediately.
 */
export function markSeenLocal(ids?: string[]): void {
  const now = new Date().toISOString();
  applyLocalStamp(ids, (n) => (n.seenAt ? n : { ...n, seenAt: now }));
  recomputeCounts();
  const client = sessionClient();
  if (!client) return;
  void markNotificationsSeen(client, ids)
    .then((counts) => setNotifState("counts", counts))
    .catch(() => undefined);
}

/**
 * Optimistically mark notifications READ (read implies seen), then POST. `ids`
 * omitted marks every loaded notification.
 */
export function markReadLocal(ids?: string[]): void {
  const now = new Date().toISOString();
  applyLocalStamp(ids, (n) => ({
    ...n,
    readAt: n.readAt ?? now,
    seenAt: n.seenAt ?? now,
  }));
  recomputeCounts();
  const client = sessionClient();
  if (!client) return;
  void markNotificationsRead(client, ids)
    .then((counts) => setNotifState("counts", counts))
    .catch(() => undefined);
}

/** Apply a per-item transform to the targeted ids (or all when omitted). */
function applyLocalStamp(
  ids: string[] | undefined,
  transform: (n: Notification) => Notification,
): void {
  const idSet = ids && ids.length > 0 ? new Set(ids) : null;
  setNotifState("items", (prev) =>
    prev.map((n) => (idSet === null || idSet.has(n.id) ? transform(n) : n)),
  );
}

/** Recompute per-type unseen counts from the loaded items (optimistic). */
function recomputeCounts(): void {
  let mention = 0;
  let reply = 0;
  let message = 0;
  for (const n of notifState.items) {
    if (n.seenAt) continue;
    if (n.type === "mention") mention += 1;
    else if (n.type === "reply") reply += 1;
    else if (n.type === "message") message += 1;
  }
  setNotifState("counts", { mention, reply, message });
}

/** Clear all notification state (logout). */
export function clearNotifications(): void {
  setNotifState({ items: [], counts: { mention: 0, reply: 0, message: 0 } });
}

// --- WS wiring --------------------------------------------------------------

const installed = new WeakSet<OfscpWsClient>();

/**
 * Install the single `notification.created` → store listener on `ws`
 * (idempotent), for the live inbox. Called once per connection by the auth
 * controller on adopt, BEFORE connecting, mirroring the read-marker listener — so
 * an event that lands right after (re)connect is captured, not raced.
 */
export function installNotificationListener(ws: OfscpWsClient): void {
  if (installed.has(ws)) return;
  installed.add(ws);
  ws.on("notification.created", (e) => {
    const data = (e as { data?: { notification?: Notification } }).data;
    if (data?.notification) applyNotificationCreated(data.notification);
  });
  // Re-hydrate the feed after each (re)connect so a device that was offline
  // catches up on notifications it missed (the event is fire-and-forget).
  ws.onState((s) => {
    if (s === "connected") void hydrateNotifications();
  });
}
