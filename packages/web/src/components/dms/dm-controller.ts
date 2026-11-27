/**
 * DM controller (P8): the bridge between the live {@link OfscpWsClient}, the DM
 * REST surface, the local sent-store, and the reactive DM store for one open
 * conversation.
 *
 * `openConversation(...)` does the §7.4 dance:
 *   1. hydrate the merged thread with the newest window of this user's
 *      locally-retained SENT messages (the server keeps no sender copy — §8.3),
 *   2. backfill the most-recent page of RECEIVED history from the caller's inbox
 *      (`GET /api/dms/{dmId}/messages`, backward) into the same thread,
 *   3. subscribe over WS with the `dm_` id and fold incoming `dm.message`
 *      (received) events into the thread live,
 *   4. record the thread's timeline head (`stores/timeline-heads.ts`): the
 *      newest RECEIVED message the inbox timeline delivered, which
 *      auto-mark-read names (§7.7). A newly delivered `dm.message` moves it and
 *      the newest inbox page settles it; replacements (edits, deletes), older
 *      pages and reply listings never touch it (see {@link isNewDelivery}).
 * The store de-dupes received + sent by `id` and orders by `createdAt`.
 *
 * The conversation has one lifetime, ended by `close()` or by the caller's
 * `signal` (a view's {@link startDmSession}, `components/shared/open-session.ts`):
 * once it ends, the listeners are off, the inbox loads are aborted, and a page
 * that still arrives is dropped rather than written to the store. A cancelled
 * open therefore never touches state (the thread, its timeline head) owned by a
 * later open of the same conversation.
 *
 * History is WINDOWED on both sides rather than drained: `loadOlder()` on the
 * returned handle extends the inbox page AND the local sent window together (see
 * {@link sentWindow} for why they must move together).
 *
 * Sends live in `dm-send.ts`, reactions / edit / delete in `dm-mutations.ts`,
 * the typing signals in `dm-typing.ts`.
 */
import type {
  Message,
  Reaction,
  WsDmMessage,
  WsDmReaction,
  WsDmTyping,
  WsEnvelope,
} from "@forumall/shared";
import { fetchDmMessages } from "../../lib/dm-api.ts";
import type { DmSentStore, SentDmMessage } from "../../lib/dm-store.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import type { OfscpWsClient } from "../../lib/ofscp-ws.ts";
import {
  addDmReactionAgg,
  applyDmEdit,
  dmThread,
  removeDmReactionAgg,
  setDmOlderCursor,
  setDmTyping,
  tombstoneDmMessage,
  upsertConversation,
  upsertDmMessage,
} from "../../stores/dms.ts";
import {
  advanceTimelineHead,
  resetTimelineHead,
  settleTimelineHead,
  timelineHeadFor,
} from "../../stores/timeline-heads.ts";
import { closedError, closedReason } from "../shared/open-session.ts";

/** History page size for the inbox backfill + each "load older" page. */
export const DM_HISTORY_PAGE_SIZE = 50;

/**
 * Which locally-retained SENT messages belong in the currently-loaded window.
 *
 * A DM thread merges two independently-paged sources (§8.3): the RECEIVED inbox
 * (paged over the server's `seq` cursor) and the caller's own SENT messages
 * (client-retained, no server copy). Windowing only the inbox would still drag
 * the entire sent log into memory, so the sent side is windowed too — but the
 * two windows must not leave a HOLE in the merged timeline.
 *
 * The rule, given `all` ascending by `createdAt`:
 *   - always take the newest `limit` sent messages (so an only-sent conversation
 *     — no inbox row at all — still renders its newest page and can page back),
 *   - PLUS every sent message at or after `downTo` (the oldest RECEIVED message
 *     currently loaded). That second clause is what closes the hole: everything
 *     newer than the oldest loaded received message is fully covered on both
 *     sides, so the merged timeline is gapless from `downTo` up.
 * Both clauses are suffixes of an ascending list, so the result is the longer
 * suffix — returned ascending, ready to fold into the store.
 *
 * The floor clause is capped at ONE extra page so the window stays bounded: a
 * §4.4.2 timestamp has second precision, so a burst can put more than a page of
 * messages on the same `createdAt`, and an uncapped floor would then drag the
 * whole log in — exactly what the windowing exists to avoid. Hitting the cap can
 * only hide sent messages sharing the boundary second, at the very top edge of
 * the window, and the next `loadOlder()` reveals them.
 */
export function sentWindow(
  all: readonly SentDmMessage[],
  opts: { limit: number; downTo?: string },
): SentDmMessage[] {
  const limit = Math.max(0, opts.limit);
  let start = Math.max(0, all.length - limit);
  const floorCap = Math.max(0, all.length - limit * 2);
  const downTo = opts.downTo;
  if (downTo !== undefined) {
    while (start > floorCap && (all[start - 1] as SentDmMessage).createdAt >= downTo) start -= 1;
  }
  return all.slice(start);
}

export interface OpenConversationDeps {
  client: OfscpClient;
  ws: OfscpWsClient;
  /** The deterministic conversation id (`deriveDmId`, §7.4). */
  dmId: string;
  /** The current user (used for thread authorship + the sent-store scope). */
  me: string;
  /** The other participant `handle@domain`. */
  counterparty: string;
  /** This user's local sent-store (scoped to `me`). */
  sentStore: DmSentStore;
  /**
   * Ends the conversation from outside, as `close()` does. A view passes it so
   * a switch can close the old conversation while it is still opening (before
   * there is a handle to close); the pending `openConversation` then rejects
   * with the signal's reason.
   */
  signal?: AbortSignal;
}

export interface ConversationHandle {
  /**
   * Load the next OLDER window of the thread — one backward inbox page plus one
   * more page of locally-retained sent messages. Returns whether more remain.
   */
  loadOlder(): Promise<boolean>;
  /**
   * End the conversation (thread switch / unmount): tear down the WS listeners,
   * unsubscribe, and abort the inbox loads still running for it. Idempotent.
   */
  close(): void;
}

/** What {@link isNewDelivery} knows of a `dm.message`'s message and the thread. */
export interface DeliveryFacts {
  /** The message is the caller's own. */
  mine: boolean;
  /** The event carries `editedAt` / `deletedAt`. */
  edited: boolean;
  deleted: boolean;
  /** The thread already holds a message with this id. */
  held: boolean;
  /** The message's `createdAt`. */
  createdAt: string;
  /**
   * `createdAt` of the thread's current timeline head, or, with no head yet,
   * of the oldest received message loaded (the window's floor); absent when
   * neither exists.
   */
  reference?: string;
}

/**
 * Whether a `dm.message` is a newly delivered RECEIVED message — the inbox
 * timeline's new front — rather than a replacement of a message delivered
 * before (§7.4).
 *
 *  - A held id, a tombstone, or the caller's own message never is.
 *  - An unedited message the thread does not hold is a create, delivered live
 *    or replayed on resume in commit order (§7.1), so it is the newest.
 *  - An EDITED one the thread does not hold is either an edit of an older
 *    message outside the loaded window, or a message created and edited while
 *    this device was offline (a resume replays current state). The loaded
 *    window is gapless from its floor up to the head, so it is new exactly when
 *    it is not older than the head (or the floor, with no head yet). `editedAt`
 *    alone cannot tell the two apart.
 */
export function isNewDelivery(f: DeliveryFacts): boolean {
  if (f.mine || f.deleted || f.held) return false;
  if (!f.edited) return true;
  return f.reference === undefined || f.createdAt >= f.reference;
}

/**
 * Open a conversation: hydrate the newest window of local sent history, backfill
 * the most-recent page of received inbox history, subscribe with the `dm_` id,
 * and fold live `dm.message` events into the store. Returns a handle for paging
 * further back + teardown.
 *
 * History is WINDOWED: a long thread loads one page from each side rather than
 * everything, and `loadOlder()` (the thread's "Load older messages" button / a
 * scroll to the top) extends both windows together.
 */
export async function openConversation(deps: OpenConversationDeps): Promise<ConversationHandle> {
  const { client, ws, dmId, me, counterparty, sentStore } = deps;
  deps.signal?.throwIfAborted();
  // The conversation's lifetime: the inbox loads carry `signal`, and `close()`
  // aborts it (see the module doc).
  const lifetime = new AbortController();
  const { signal } = lifetime;

  // Remember the counterparty so an only-sent conversation still lists it.
  sentStore.rememberCounterparty(dmId, counterparty);

  // --- Paging state for this open conversation -----------------------------
  /** Next backward inbox page cursor; `null` once the inbox is fully paged. */
  let olderCursor: string | null = null;
  /** `createdAt` of the oldest RECEIVED message loaded — the sent window's floor. */
  let oldestReceivedAt: string | undefined;
  /** How many of the newest locally-retained sent messages are hydrated. */
  let sentLimit = DM_HISTORY_PAGE_SIZE;
  /** Whether the local sent log still holds messages older than the window. */
  let sentHasMore = false;

  /**
   * Fold the current sent window into the thread. A sent message the author
   * edited/deleted carries those markers locally (own copies are client-retained,
   * §8.3) — restore them so a reload reflects the edit / tombstone. Idempotent:
   * re-running after the window grows only adds the newly-covered messages (the
   * store de-dupes by id).
   */
  const hydrateSent = (): void => {
    const all = sentStore.list(dmId);
    const window = sentWindow(all, {
      limit: sentLimit,
      ...(oldestReceivedAt !== undefined ? { downTo: oldestReceivedAt } : {}),
    });
    sentHasMore = window.length < all.length;
    for (const sent of window) {
      if (sent.deletedAt) {
        upsertDmMessage(dmId, {
          id: sent.id,
          author: sent.author,
          content: sent.content,
          createdAt: sent.createdAt,
          mine: true,
        });
        tombstoneDmMessage(dmId, sent.id, sent.deletedAt);
        continue;
      }
      upsertDmMessage(dmId, {
        id: sent.id,
        author: sent.author,
        content: sent.content,
        ...(sent.attachments && sent.attachments.length > 0
          ? { attachments: sent.attachments }
          : {}),
        ...(sent.reference ? { reference: sent.reference } : {}),
        createdAt: sent.createdAt,
        ...(sent.editedAt ? { editedAt: sent.editedAt } : {}),
        ...(sent.localVersion ? { localVersion: sent.localVersion } : {}),
        ...(sent.clientMessageId !== undefined ? { clientMessageId: sent.clientMessageId } : {}),
        mine: true,
      });
    }
  };

  /** Publish the paging state the thread view renders its affordance from. */
  const publishOlderState = (): void => {
    setDmOlderCursor(dmId, olderCursor, olderCursor !== null || sentHasMore);
  };

  /**
   * Fetch one BACKWARD page of the caller's inbox (newest-first), advancing the
   * paging cursor + the sent window's floor. A conversation the caller has only
   * SENT to has no inbox row → 404; that's expected (the local sent history still
   * renders), and is treated as "no received history" rather than an error.
   *
   * Fetching and FOLDING are separate steps on purpose: the floor has to be known
   * before {@link hydrateSent} runs (so the sent window covers it), while the
   * server's copy must be folded LAST — it is authoritative for a message's
   * current content, and must win over the client-retained sent copy of the same
   * message (which the server also returns, author-scoped, for a same-node peer).
   */
  const fetchReceivedPage = async (cursor: string | null): Promise<Message[]> => {
    let page: Awaited<ReturnType<typeof fetchDmMessages>>;
    try {
      page = await fetchDmMessages(client, dmId, {
        ...(cursor ? { cursor } : {}),
        limit: DM_HISTORY_PAGE_SIZE,
        direction: "backward",
        signal,
      });
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status: number }).status === 404
      ) {
        olderCursor = null;
        return [];
      }
      throw err;
    }
    for (const m of page.messages) {
      if (oldestReceivedAt === undefined || m.createdAt < oldestReceivedAt) {
        oldestReceivedAt = m.createdAt;
      }
    }
    olderCursor = page.nextCursor;
    return page.messages;
  };

  /** Fold a fetched inbox page into the thread (see {@link fetchReceivedPage}). */
  const foldReceived = (messages: Message[]): void => {
    for (const m of messages) {
      // Upsert the message into the thread first (so it has a row + position),
      // then tombstone in place when it's deleted. A tombstoned message the
      // viewer never saw live (e.g. the author deleted a message they sent,
      // which lands in THIS recipient's inbox as a tombstone) must still render
      // its tombstone on backfill — tombstoning alone is a no-op if the row is
      // absent, so the upsert-then-tombstone order is load-bearing.
      upsertDmMessage(dmId, {
        id: m.id,
        author: m.author,
        content: m.content,
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
        ...(m.reference ? { reference: m.reference } : {}),
        createdAt: m.createdAt,
        ...(m.editedAt ? { editedAt: m.editedAt } : {}),
        ...((m as { cursor?: string }).cursor ? { cursor: (m as { cursor?: string }).cursor } : {}),
        mine: m.author === me,
      });
      if (m.deletedAt) {
        tombstoneDmMessage(dmId, m.id, m.deletedAt);
      }
      // Fold the reactions the server embeds onto each inbox message.
      for (const r of (m as { reactions?: Reaction[] }).reactions ?? []) {
        addDmReactionAgg(dmId, r);
      }
    }
  };

  /**
   * The reference an edited, unheld delivery is compared with (see
   * {@link isNewDelivery}): the head's `createdAt`, else the window's floor.
   */
  const deliveryReference = (): string | undefined => {
    const head = timelineHeadFor(dmId);
    if (head === undefined) return oldestReceivedAt;
    return dmThread(dmId).find((x) => x.id === head)?.createdAt ?? oldestReceivedAt;
  };
  /**
   * Edited, unheld received messages delivered before the newest inbox page
   * settled the head: the window is not known yet, so they are judged once it
   * is (step 4).
   */
  let firstPageSettled = false;
  const editedBeforeSettle: { id: string; createdAt: string }[] = [];

  // The thread's timeline head starts over with this open.
  resetTimelineHead(dmId);

  // 1) Hydrate the newest page of THIS user's locally-retained sent messages (no
  // server copy) so the thread paints immediately; step 4 re-runs this with the
  // received floor once the inbox page has landed.
  hydrateSent();

  // 2) Wire the live `dm.message` listener BEFORE subscribing so no event is
  // missed. Filter to THIS conversation by `dmId` (the event carries `dmId`, not
  // a `channelId`). Our own sent messages can come back over this channel too (a
  // local DM's recipient inbox is on our provider, and our dmId subscription
  // receives it); `upsertDmMessage` matches on `clientMessageId` / `id`, so the
  // echo reconciles with the locally retained copy instead of duplicating. The live
  // event now also carries attachments / reply reference / editedAt / deletedAt
  // (parity with channel `message.created`) — reconcile edits + tombstones in
  // place, exactly like the chat store does.
  const offDm = ws.on("dm.message", (e: WsEnvelope) => {
    const data = (e as WsDmMessage).data;
    if (data.dmId !== dmId) return;
    const m = data.message;
    const mine = m.author === me;
    // §7.4: a `dm.message` for a message already held replaces it, and edits and
    // deletes of messages outside the window carry `editedAt` / `deletedAt`.
    // Only a newly delivered received message is the inbox timeline's newest.
    const facts = {
      mine,
      edited: m.editedAt !== undefined,
      deleted: m.deletedAt !== undefined,
      held: dmThread(dmId).some((x) => x.id === m.id),
      createdAt: m.createdAt,
    };
    if (facts.edited && !firstPageSettled) {
      if (isNewDelivery({ ...facts, edited: false })) {
        editedBeforeSettle.push({ id: m.id, createdAt: m.createdAt });
      }
    } else {
      const reference = deliveryReference();
      if (isNewDelivery({ ...facts, ...(reference !== undefined ? { reference } : {}) })) {
        advanceTimelineHead(dmId, m.id);
      }
    }
    if (m.deletedAt) {
      tombstoneDmMessage(dmId, m.id, m.deletedAt);
      return;
    }
    const next = {
      id: m.id,
      author: m.author,
      content: m.content,
      ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      ...(m.reference ? { reference: m.reference } : {}),
      createdAt: m.createdAt,
      ...(m.editedAt ? { editedAt: m.editedAt } : {}),
      ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
      ...(data.cursor ? { cursor: data.cursor } : {}),
      mine,
    };
    if (m.editedAt) applyDmEdit(dmId, next);
    else upsertDmMessage(dmId, next);
    // Keep the sidebar preview fresh on live receipt.
    upsertConversation({
      dmId,
      counterparty,
      lastMessageText: m.content.text ?? "",
      updatedAt: m.createdAt,
    });
  });

  // 2b) `dm.reaction` — fold add/remove into the per-message reaction aggregate
  // (mirrors the chat store). The event is fanned to BOTH participants, so this
  // covers our own optimistic toggles being confirmed AND the counterparty's.
  const offReaction = ws.on("dm.reaction", (e: WsEnvelope) => {
    const data = (e as WsDmReaction).data;
    if (data.dmId !== dmId) return;
    if (data.state === "added" && data.reaction) {
      addDmReactionAgg(dmId, data.reaction as Reaction);
    } else if (data.state === "removed" && data.author && data.key) {
      removeDmReactionAgg(dmId, data.messageId, data.key, data.author);
    }
  });

  // 2c) `dm.typing` — drive the counterparty's typing indicator (DM-scoped).
  const offTyping = ws.on("dm.typing", (e: WsEnvelope) => {
    const data = (e as WsDmTyping).data;
    if (data.dmId !== dmId) return;
    if (data.user === me) return; // never show our own typing
    setDmTyping(dmId, data.user, data.state === "start");
  });

  // 3) Subscribe with the `dm_` id as the channel (§7.4 live delivery).
  ws.subscribe([dmId]);

  const close = (): void => {
    if (signal.aborted) return;
    lifetime.abort();
    deps.signal?.removeEventListener("abort", close);
    resetTimelineHead(dmId);
    offDm();
    offReaction();
    offTyping();
    ws.unsubscribe([dmId]);
  };
  deps.signal?.addEventListener("abort", close, { once: true });

  // 4) Backfill the most-recent page of RECEIVED inbox history (§7.4 backward
  // paging — newest-first; the store orders the merged thread by `createdAt`, so
  // arrival order doesn't matter). Fetch → re-hydrate the sent side down to that
  // page's floor (no hole in the merged window) → fold the page last (the server
  // copy is authoritative), then publish the paging state.
  let firstPage: Message[];
  try {
    firstPage = await fetchReceivedPage(null);
  } catch (err) {
    // A failed open leaves nothing subscribed; a closed one reports the close.
    close();
    throw closedReason(deps.signal) ?? err;
  }
  // Closed while the page was in flight: write nothing.
  if (signal.aborted) throw closedReason(deps.signal) ?? closedError("conversation");
  hydrateSent();
  foldReceived(firstPage);
  // The newest inbox page (newest first) settles the head against any delivery
  // that arrived while it was in flight; only received messages qualify.
  settleTimelineHead(
    dmId,
    firstPage.filter((m) => m.author !== me).map((m) => m.id),
  );
  // Now the window is known, judge the edited deliveries that arrived before it
  // (oldest first, so the newest new one ends as the head). One deleted since
  // it arrived is a tombstone now, which never is a delivery.
  firstPageSettled = true;
  editedBeforeSettle.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const e of editedBeforeSettle) {
    const reference = deliveryReference();
    const delivered = isNewDelivery({
      mine: false,
      edited: true,
      deleted: dmThread(dmId).some((x) => x.id === e.id && x.deletedAt !== undefined),
      held: false,
      createdAt: e.createdAt,
      ...(reference !== undefined ? { reference } : {}),
    });
    if (delivered) advanceTimelineHead(dmId, e.id);
  }
  editedBeforeSettle.length = 0;
  publishOlderState();

  return {
    async loadOlder(): Promise<boolean> {
      // Extend BOTH windows by a page: one backward inbox page (when the inbox
      // still has one) and one more page of local sent messages — a thread whose
      // older half is entirely our own messages must still page back. Same
      // fetch → hydrate → fold ordering as the initial load.
      if (signal.aborted) return false;
      let page: Message[];
      try {
        page = olderCursor ? await fetchReceivedPage(olderCursor) : [];
      } catch (err) {
        if (signal.aborted) return false;
        throw err;
      }
      // Closed while the page was in flight: the thread belongs to whatever
      // opens this conversation next, so neither the page nor its cursor lands.
      if (signal.aborted) return false;
      sentLimit += DM_HISTORY_PAGE_SIZE;
      hydrateSent();
      foldReceived(page);
      publishOlderState();
      return olderCursor !== null || sentHasMore;
    },
    close,
  };
}
