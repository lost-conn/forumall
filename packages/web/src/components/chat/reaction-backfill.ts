/**
 * Reaction backfill for newly loaded channel messages.
 *
 * A channel timeline and a reply listing hold messages only (§7.2,
 * lost-conn/ofscp#37), so a message's reactions come from its own
 * `GET …/messages/{messageId}/reactions` listing. Every path that loads
 * messages over REST (the first history page, each older page, a reply
 * listing) hands the loaded ids to {@link backfillReactions}.
 *
 * ## Bounded and in order
 * One call fetches the listings of one loaded page (≤ a page of ids), walking
 * the ids in the order given with at most {@link REACTION_FETCH_CONCURRENCY}
 * requests in flight. A listing that fails (a deleted or no longer visible
 * message may 404) is skipped; the rest still land.
 *
 * ## Live events win over the snapshot
 * The store's reaction aggregate is additive (`addReactionAgg` never removes).
 * A listing is a snapshot taken when the server answered, so folding it in
 * blindly would resurrect a reaction that a live `reaction.removed` took away
 * while the fetch was in flight. The controller therefore reports every live
 * reaction event through {@link noteLiveReaction}; for a message whose
 * listing is still pending, that `(key, author)` pair is marked, and the
 * snapshot's entry for it is not applied, because the live event already put
 * the store in the newer state.
 *
 * ## Cancelled with the channel
 * That guard only holds while the channel's listeners run. Once the view closes
 * the channel nothing reports live events any more, so a listing answered
 * after the close could put back a reaction removed in the meantime, and the
 * additive store would keep that ghost across a reopen. Every backfill
 * therefore takes the channel's lifetime `signal` (aborted by the controller's
 * `close()`): once it aborts, no queued listing starts, the in-flight requests
 * are aborted, and any listing that still answers is dropped, never applied.
 */
import type { Reaction } from "@forumall/shared";
import { fetchReactions } from "../../lib/chat-api.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import { addReactionAgg } from "../../stores/chat.ts";

/** Most `…/reactions` requests one backfill keeps in flight at once. */
export const REACTION_FETCH_CONCURRENCY = 6;

/** One `(key, author)` pair as a set member (NUL cannot occur in either). */
function pairOf(key: string, author: string): string {
  return `${key}\u0000${author}`;
}

/**
 * Run `task` over `items` in their order, never more than `limit` at once.
 * Each worker takes the next unstarted item, so requests start in order.
 */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    // Checked before each start, so nothing queued begins after an abort.
    while (next < items.length && !signal?.aborted) {
      const item = items[next] as T;
      next += 1;
      await task(item);
    }
  };
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * Every running backfill, by channel: each entry maps the messageIds whose
 * listings it is fetching to the live `(key, author)` pairs seen for them since
 * it began. An entry is removed when its load ends, so only in-flight listings
 * are tracked.
 */
const running = new Map<string, Set<Map<string, Set<string>>>>();

/**
 * Record a live `reaction.added` / `reaction.removed` on `messageId` in
 * `channelId`, so a listing for it still in flight does not overwrite the newer
 * live state. Every reaction listener for a channel calls this.
 */
export function noteLiveReaction(
  channelId: string,
  messageId: string,
  key: string,
  author: string,
): void {
  for (const live of running.get(channelId) ?? []) live.get(messageId)?.add(pairOf(key, author));
}

/** What a backfill needs: the channel's REST client, its ids and its lifetime. */
export interface BackfillDeps {
  client: OfscpClient;
  groupId: string;
  channelId: string;
  /**
   * The channel's lifetime: once aborted, no listing starts, in-flight requests
   * are aborted and their answers are dropped. Omitted only by a caller whose
   * backfill outlives no view (a one-shot load).
   */
  signal?: AbortSignal;
}

/**
 * Fetch and fold the reactions of `messageIds` (the messages a page just
 * loaded) into the store. Resolves once every listing has been applied or has
 * failed, or, after `signal` aborts, as soon as the in-flight requests settle
 * (nothing more is applied then).
 */
export async function backfillReactions(
  deps: BackfillDeps,
  messageIds: readonly string[],
): Promise<void> {
  const { client, groupId, channelId, signal } = deps;
  const ids = [...new Set(messageIds)];
  if (ids.length === 0 || signal?.aborted) return;
  const live = new Map(ids.map((id) => [id, new Set<string>()]));
  let channelLoads = running.get(channelId);
  if (!channelLoads) {
    channelLoads = new Set();
    running.set(channelId, channelLoads);
  }
  channelLoads.add(live);
  try {
    await forEachBounded(ids, REACTION_FETCH_CONCURRENCY, signal, async (messageId) => {
      let reactions: Reaction[];
      try {
        reactions = await fetchReactions(client, groupId, channelId, messageId, signal);
      } catch {
        // A deleted or no longer visible message's listing may 404; its
        // reactions simply stay as the live events left them. An aborted
        // request lands here too, and is equally not applied.
        return;
      }
      // The channel closed while this listing was in flight: no live events
      // were reported since, so the snapshot may be stale. Drop it.
      if (signal?.aborted) return;
      const liveSince = live.get(messageId) ?? new Set<string>();
      for (const r of reactions) {
        if (liveSince.has(pairOf(r.key, r.author))) continue;
        addReactionAgg(channelId, r);
      }
    });
  } finally {
    channelLoads.delete(live);
    if (channelLoads.size === 0) running.delete(channelId);
  }
}
