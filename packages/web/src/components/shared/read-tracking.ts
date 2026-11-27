/**
 * Read tracking for an open timeline (a channel in `ChatView`, a DM thread in
 * `DmsPage`), OFSCP §7.7: auto-mark-read and the "New messages" divider. Both
 * work from the loaded messages' ids and positions (`lib/read-position.ts`) and
 * the provider-reported marker, never from decoded cursors (§2.5).
 */
import { type Accessor, createEffect, createSignal, on } from "solid-js";
import {
  type ReadSnapshot,
  type TimelineEntry,
  dividerBeforeId,
  newestConfirmedId,
} from "../../lib/read-position.ts";
import { markRead, readSnapshotFor } from "../../stores/read-markers.ts";

/**
 * Keep the scope's marker at the newest confirmed message `keep` accepts, while
 * `enabled()` holds (read untracked, when the newest message changes). Re-fires
 * as new messages arrive.
 */
export function trackNewestRead<T extends TimelineEntry>(opts: {
  readonly scopeId: Accessor<string>;
  readonly messages: Accessor<readonly T[]>;
  readonly keep?: (m: T) => boolean;
  readonly enabled?: () => boolean;
}): void {
  const newest = () => newestConfirmedId(opts.messages(), opts.keep);
  createEffect(
    on(
      () => [opts.scopeId(), newest()] as const,
      ([scopeId, id]) => {
        if (id !== undefined && (opts.enabled?.() ?? true)) markRead(scopeId, id);
      },
    ),
  );
}

/**
 * The id of the message the "New messages" divider sits above, or `null`.
 * The scope's read state is snapshotted when the scope opens (before
 * auto-mark-read moves it) and the divider is placed once, when `ready()` says
 * the history has loaded, so it stays put for this viewing session as new
 * messages arrive and the live marker advances.
 *
 * Call this BEFORE {@link trackNewestRead} in the same component, so that on a
 * scope switch the snapshot is taken before the marker moves.
 */
export function createUnreadDivider(opts: {
  readonly scopeId: Accessor<string>;
  readonly messages: Accessor<readonly TimelineEntry[]>;
  readonly ready: Accessor<boolean>;
  readonly self: Accessor<string | undefined>;
}): Accessor<string | null> {
  const [divider, setDivider] = createSignal<string | null>(null);
  let snapshot: ReadSnapshot = { unreadCount: 0 };
  let placed = false;
  createEffect(
    on(opts.scopeId, (scopeId) => {
      snapshot = readSnapshotFor(scopeId);
      placed = false;
      setDivider(null);
    }),
  );
  createEffect(() => {
    if (placed || !opts.ready()) return;
    placed = true;
    setDivider(dividerBeforeId(opts.messages(), snapshot, opts.self()));
  });
  return divider;
}
