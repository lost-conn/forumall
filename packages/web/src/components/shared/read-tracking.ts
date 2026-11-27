/**
 * Read tracking for an open timeline (a channel in `ChatView`, a DM thread in
 * `DmsPage`), OFSCP §7.7: auto-mark-read and the "New messages" divider.
 * Auto-mark-read follows the scope's timeline head (`stores/timeline-heads.ts`);
 * the divider works from the loaded messages' ids and positions
 * (`lib/read-position.ts`) and the provider-reported marker. Neither decodes a
 * cursor (§2.5).
 */
import { type Accessor, createEffect, createSignal, on } from "solid-js";
import { type ReadSnapshot, type TimelineEntry, dividerBeforeId } from "../../lib/read-position.ts";
import { markRead, readSnapshotFor } from "../../stores/read-markers.ts";
import { timelineHeadFor } from "../../stores/timeline-heads.ts";

/**
 * Keep the scope's marker at its timeline head (the newest message the
 * provider delivered as part of the timeline, `stores/timeline-heads.ts`),
 * while `enabled()` holds (read untracked, when the head moves). Re-fires as new
 * messages arrive. The head is tracked as messages arrive rather than read off
 * the loaded list, whose last entry may be an older message loaded out of
 * timeline order (a reply listing).
 */
export function trackNewestRead(opts: {
  readonly scopeId: Accessor<string>;
  readonly enabled?: () => boolean;
}): void {
  createEffect(
    on(
      () => {
        const scopeId = opts.scopeId();
        return [scopeId, timelineHeadFor(scopeId)] as const;
      },
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
