/**
 * Home-feed store (P8, spec §7.6). Holds the caller's follow POINTERS and derives
 * the one merged "follows" timeline the Home screen renders.
 *
 * ## Composed client-side — nothing is a compiled feed
 * The server stores/serves NO feed: it only knows *which* channels the caller
 * follows. The feed controller (`components/feed/feed-controller.ts`) reads each
 * followed channel's recent history over REST and subscribes for live updates
 * over the appropriate provider's WS, folding every message into the SHARED chat
 * store (`stores/chat.ts`) keyed by channel id — so edits land in place,
 * tombstones render, and de-dupe by message id is reused for free.
 *
 * This store keeps:
 *  - the follow registry (channel id → pointer metadata: group + source provider),
 *  - per-source-channel load/access state (so a channel whose reads start failing
 *    is pruned from the feed — a stale pointer).
 *
 * The merged timeline itself is DERIVED (see `mergedTimeline`): it reads every
 * active followed channel's `chat.messages[channelId]` and merges them ordered by
 * `createdAt`, newest-first, de-duped by id. Because it reads the reactive chat
 * store, a live `message.created/updated/deleted` on any followed channel updates
 * the Home feed automatically.
 */
import { createStore, produce } from "solid-js/store";
import { compareByCursorThenId } from "../lib/cursor.ts";
import { type ChatMessage, chat } from "./chat.ts";

/** A followed channel as the feed cares about it (a pointer + render metadata). */
export interface FollowedChannel {
  /** Local channel id (the key into the shared chat store). */
  channelId: string;
  /** The raw follow `channel` ref (bare id or URI) — used to unfollow. */
  ref: string;
  /** Owning group id, when known (needed to read history + post). */
  groupId?: string;
  /** Provider host this channel's source lives on (home or, later, a peer). */
  host: string;
  /** Channel name for the feed item header (filled once history/metadata loads). */
  name?: string;
  /** Group name for the feed item header. */
  groupName?: string;
  /** `true` once its reads have failed / access was lost → pruned from the feed. */
  pruned?: boolean;
}

interface FeedState {
  /** Followed channels by local channel id. */
  follows: Record<string, FollowedChannel>;
  /** True after the first follow-list load (so the UI can distinguish empty). */
  loaded: boolean;
}

const [feed, setFeed] = createStore<FeedState>({ follows: {}, loaded: false });

export { feed };

/** A merged-timeline item: a chat message tagged with its source channel. */
export interface FeedItem extends ChatMessage {
  channelId: string;
  channelName?: string;
  groupId?: string;
  groupName?: string;
  host: string;
}

/** Replace the whole follow registry (after a full follow-list load). */
export function setFollows(list: FollowedChannel[]): void {
  setFeed(
    produce((s) => {
      const next: Record<string, FollowedChannel> = {};
      for (const f of list) {
        // Preserve any already-loaded names across a refresh.
        next[f.channelId] = { ...s.follows[f.channelId], ...f };
      }
      s.follows = next;
      s.loaded = true;
    }),
  );
}

/** Patch a follow's display metadata (name/groupName) once it resolves. */
export function setFollowMeta(
  channelId: string,
  meta: { name?: string; groupName?: string },
): void {
  setFeed("follows", channelId, (prev) => (prev ? { ...prev, ...meta } : prev));
}

/**
 * Prune a followed channel from the feed because its reads started failing /
 * access was lost (§7.6 "drop a channel if reads start failing"). The pointer is
 * marked `pruned` (not deleted) so the UI can show *why* it dropped out and the
 * follow row itself still exists on the server until the user unfollows.
 */
export function pruneFollow(channelId: string): void {
  setFeed("follows", channelId, (prev) => (prev ? { ...prev, pruned: true } : prev));
}

/** The active (non-pruned) followed channels. */
export function activeFollows(): FollowedChannel[] {
  return Object.values(feed.follows).filter((f) => !f.pruned);
}

/**
 * The merged home timeline: every active followed channel's messages, ordered by
 * `createdAt` newest-first and de-duped by id (each channel's per-channel list is
 * already de-duped by `stores/chat.ts`). Pure derivation over the reactive chat +
 * feed stores, so any live message/edit/tombstone on a followed channel re-runs
 * it. Optimistic-echo (`pending`) rows are excluded — the feed shows canonical
 * cross-channel content, not the local-compose lifecycle.
 */
export function mergedTimeline(): FeedItem[] {
  const items: FeedItem[] = [];
  for (const f of Object.values(feed.follows)) {
    if (f.pruned) continue;
    const list = chat.messages[f.channelId] ?? [];
    for (const m of list) {
      if (m.pending) continue; // skip un-reconciled local echoes
      items.push({
        ...m,
        channelId: f.channelId,
        channelName: f.name,
        groupId: f.groupId,
        groupName: f.groupName,
        host: f.host,
      });
    }
  }
  // Newest-first by `createdAt`. Server timestamps are second-resolution (the
  // shared `rfc3339Timestamp` drops millis), so two messages posted within the
  // same second tie — break the tie by the DECODED cursor `seq`, which is the
  // provider's monotonic timeline position (`lib/cursor.ts`; the encoded string
  // is base64 JSON and is NOT order-preserving). This list renders newest-first,
  // so the shared ascending comparator is negated — which also flips its
  // cursorless-last clause, putting a (rare, non-`pending`) cursorless row first.
  items.sort((a, b) => {
    const dt = timeOf(b) - timeOf(a);
    if (dt !== 0) return dt;
    return -compareByCursorThenId(a, b);
  });
  return items;
}

/** Parse a message timestamp to ms (0 when absent/unparseable → sorts oldest). */
function timeOf(m: ChatMessage): number {
  const t = m.createdAt ? Date.parse(m.createdAt) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Reset the feed store (logout). */
export function clearFeed(): void {
  setFeed({ follows: {}, loaded: false });
}
