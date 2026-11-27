/**
 * Read positions in a timeline (OFSCP §7.7), worked out from what the client
 * already holds: message ids, the order the provider delivers them in, and the
 * order of the loaded list. Cursors are never decoded for this (§2.5): a read
 * marker names a message, and the provider alone compares positions when it
 * stores one.
 *
 *  - Which message a view marks read is the scope's timeline HEAD: the newest
 *    message the provider has delivered as part of the timeline itself (the
 *    newest history page, then live and resumed creates, which arrive in
 *    commit order). It is tracked as messages arrive (`stores/timeline-heads.ts`
 *    with {@link headAfterNewestPage}), never read off the loaded list, because
 *    the list also holds messages loaded out of timeline order (a reply
 *    listing, an edit to a message outside the window), so its last entry need
 *    not be the newest.
 *  - The "New messages" divider ({@link dividerBeforeId}) is placed by list
 *    position.
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
 * The timeline head after the scope's NEWEST history page arrives, given the
 * head recorded so far in this viewing session (`current`, from live or resumed
 * creates delivered since the scope was opened) and the page's ids newest
 * first (only those the head may name).
 *
 * The page is the newest messages at the moment the provider read it, and the
 * subscription was made before the page was requested, so a live create either
 * landed in the page or was committed after it was read:
 *
 *  - nothing recorded yet, or the recorded head is in the page → the page's
 *    newest message is the head (it is at least as new);
 *  - the recorded head is not in the page → it was committed after the page
 *    was read, so it stays. (A resume replay — which the provider sends in
 *    order, up to the present, right after `subscribe` — can deliver messages
 *    older than the page here; keeping the replayed one is then only a step
 *    behind, and the rest of the replay moves the head on to the newest.)
 */
export function headAfterNewestPage(
  current: string | undefined,
  pageNewestFirst: readonly string[],
): string | undefined {
  const newest = pageNewestFirst[0];
  if (newest === undefined) return current;
  if (current === undefined || pageNewestFirst.includes(current)) return newest;
  return current;
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
