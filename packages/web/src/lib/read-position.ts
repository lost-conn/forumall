/**
 * Read positions in a loaded timeline (OFSCP §7.7), worked out from what the
 * client already holds: message ids, and the order of the loaded list. The
 * stores keep each timeline chronological by position (history pages are
 * prepended, live messages appended), so position is the client's timeline
 * order. Cursors are never decoded for this (§2.5): a read marker names a
 * message, and the provider alone compares positions when it stores one.
 */

/** The fields of a loaded message these helpers look at. */
export interface TimelineEntry {
  readonly id: string;
  readonly author: string;
  /** An optimistic echo not yet confirmed: its id is not the provider's. */
  readonly pending?: boolean;
  readonly failed?: boolean;
}

/** A scope's read state as last reported by the provider (§7.7 `ReadMarker`). */
export interface ReadSnapshot {
  readonly lastReadMessageId?: string;
  readonly unreadCount: number;
}

/** Whether `m` carries a provider-issued id (not an unconfirmed optimistic echo). */
function confirmed(m: TimelineEntry): boolean {
  return m.pending !== true && m.failed !== true;
}

/**
 * The id of the newest confirmed message in `list` (by position) that `keep`
 * accepts, or `undefined` when there is none. This is the message a view marks
 * read: everything at or before it has been shown.
 */
export function newestConfirmedId<T extends TimelineEntry>(
  list: readonly T[],
  keep: (m: T) => boolean = () => true,
): string | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && confirmed(m) && keep(m)) return m.id;
  }
  return undefined;
}

/**
 * The id of the message the "New messages" divider sits above, or `null` for
 * no divider: the oldest unread message not authored by `self`.
 *
 *  - When the marker's message is loaded, the divider goes above the first
 *    message after it (by position) that `self` did not author.
 *  - Otherwise (nothing read yet, or the marker is older than the loaded
 *    window) the provider's `unreadCount` places it: unread messages are the
 *    newest ones not authored by `self`, so the divider goes above the
 *    `unreadCount`-th such message counting back from the newest — or above
 *    the oldest loaded one when fewer are loaded (all of them are unread).
 *    Tombstones count on both sides, as §7.7 says, since they keep their place
 *    in the list.
 */
export function dividerBeforeId(
  list: readonly TimelineEntry[],
  snapshot: ReadSnapshot,
  self: string | undefined,
): string | null {
  const others = (m: TimelineEntry): boolean => confirmed(m) && m.author !== self;
  const markerAt =
    snapshot.lastReadMessageId === undefined
      ? -1
      : list.findIndex((m) => m.id === snapshot.lastReadMessageId);
  if (markerAt !== -1) {
    for (let i = markerAt + 1; i < list.length; i++) {
      const m = list[i];
      if (m && others(m)) return m.id;
    }
    return null;
  }
  if (snapshot.unreadCount <= 0) return null;
  let seen = 0;
  let oldest: string | null = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || !others(m)) continue;
    seen++;
    oldest = m.id;
    if (seen === snapshot.unreadCount) return m.id;
  }
  return oldest;
}
