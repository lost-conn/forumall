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
 *      (received) events into the thread live.
 * The store de-dupes received + sent by `id` and orders by `createdAt`.
 *
 * History is WINDOWED on both sides rather than drained: `loadOlder()` on the
 * returned handle extends the inbox page AND the local sent window together (see
 * {@link sentWindow} for why they must move together).
 *
 * `sendDm(...)` shows an optimistic echo, POSTs the user-signed message, then on
 * success persists the canonical sent message to the local store AND reconciles
 * the echo in place. The recipient gets it via their inbox + a `dm.message`.
 */
import type {
  Attachment,
  Message,
  Reaction,
  WsDmMessage,
  WsDmReaction,
  WsDmTyping,
  WsEnvelope,
} from "@forumall/shared";
import { rfc3339Timestamp } from "@forumall/shared";
import {
  addDmReaction as apiAddDmReaction,
  removeDmReaction as apiRemoveDmReaction,
  deleteDmMessage,
  editDmMessage,
  fetchDmMessages,
  sendDmMessage,
} from "../../lib/dm-api.ts";
import type { DmSentStore, SentDmMessage } from "../../lib/dm-store.ts";
import { type OfscpClient, isDefinitiveRejection } from "../../lib/ofscp-client.ts";
import type { OfscpWsClient } from "../../lib/ofscp-ws.ts";
import {
  addDmOptimistic,
  addDmReactionAgg,
  applyDmEdit,
  dropDmOptimistic,
  markDmFailed,
  removeDmReactionAgg,
  restoreDmMessage,
  setDmOlderCursor,
  setDmTyping,
  tombstoneDmMessage,
  upsertConversation,
  upsertDmMessage,
} from "../../stores/dms.ts";

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
}

export interface ConversationHandle {
  /**
   * Load the next OLDER window of the thread — one backward inbox page plus one
   * more page of locally-retained sent messages. Returns whether more remain.
   */
  loadOlder(): Promise<boolean>;
  /** Tear down the WS listener + unsubscribe (thread switch / unmount). */
  close(): void;
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

  // 1) Hydrate the newest page of THIS user's locally-retained sent messages (no
  // server copy) so the thread paints immediately; step 4 re-runs this with the
  // received floor once the inbox page has landed.
  hydrateSent();

  // 2) Wire the live `dm.message` listener BEFORE subscribing so no event is
  // missed. Filter to THIS conversation by `dmId` (the event carries `dmId`, not
  // a `channelId`). Received messages are authored by the counterparty; our own
  // sent messages never come back over this channel (no sender copy). The live
  // event now also carries attachments / reply reference / editedAt / deletedAt
  // (parity with channel `message.created`) — reconcile edits + tombstones in
  // place, exactly like the chat store does.
  const offDm = ws.on("dm.message", (e: WsEnvelope) => {
    const data = (e as WsDmMessage).data;
    if (data.dmId !== dmId) return;
    const m = data.message;
    const mine = m.author === me;
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

  // 4) Backfill the most-recent page of RECEIVED inbox history (§7.4 backward
  // paging — newest-first; the store orders the merged thread by `createdAt`, so
  // arrival order doesn't matter). Fetch → re-hydrate the sent side down to that
  // page's floor (no hole in the merged window) → fold the page last (the server
  // copy is authoritative), then publish the paging state.
  const firstPage = await fetchReceivedPage(null);
  hydrateSent();
  foldReceived(firstPage);
  publishOlderState();

  return {
    async loadOlder(): Promise<boolean> {
      // Extend BOTH windows by a page: one backward inbox page (when the inbox
      // still has one) and one more page of local sent messages — a thread whose
      // older half is entirely our own messages must still page back. Same
      // fetch → hydrate → fold ordering as the initial load.
      const page = olderCursor ? await fetchReceivedPage(olderCursor) : [];
      sentLimit += DM_HISTORY_PAGE_SIZE;
      hydrateSent();
      foldReceived(page);
      publishOlderState();
      return olderCursor !== null || sentHasMore;
    },
    close(): void {
      offDm();
      offReaction();
      offTyping();
      ws.unsubscribe([dmId]);
    },
  };
}

export interface SendDmArgs {
  /** The home signing client (the sender's own provider) — used as the default. */
  client: OfscpClient;
  /**
   * The client the DM is DELIVERED through (§7.4): the RECIPIENT's home provider.
   * For a same-provider DM this equals `client`; for a CROSS-PROVIDER DM it is a
   * per-host client (built via `clientForHost`) targeting the recipient's domain,
   * signed by the sender's home key (the recipient's provider resolves that key
   * via §4.6). Defaults to `client` when omitted (same-provider).
   */
  deliveryClient?: OfscpClient;
  dmId: string;
  me: string;
  counterparty: string;
  text: string;
  mime?: string;
  /** Media attachments to send with the message (parity with channel sends). */
  attachments?: Attachment[];
  /** §5.3 reply pointer to the message being replied to. */
  reference?: { type: string; id: string };
  sentStore: DmSentStore;
}

/**
 * Send a DM: show an optimistic echo, POST the user-signed message, and on
 * success persist the canonical sent message locally + reconcile the echo. On
 * failure the echo is marked failed for a retry. Returns the `clientMessageId`.
 *
 * The send is delivered to the RECIPIENT's home provider (`deliveryClient`, which
 * for a cross-provider DM targets the recipient's domain). The sender still keeps
 * the canonical sent copy locally — the server keeps no sender copy (§8.3).
 */
export async function sendDm(args: SendDmArgs): Promise<string> {
  const { client, deliveryClient, dmId, me, counterparty, text, mime, sentStore } = args;
  const attachments = args.attachments ?? [];
  const reference = args.reference;
  const sendClient = deliveryClient ?? client;
  sentStore.rememberCounterparty(dmId, counterparty);
  const content = { mime: mime ?? "text/plain", text };
  // We don't know the clientMessageId until the API mints one; pre-generate the
  // optimistic entry with a placeholder created in the API call, so instead we
  // optimistically echo with a temporary id and reconcile on the response.
  const createdAt = new Date().toISOString();

  // Optimistic echo keyed by a temp client id we control here.
  const tempCmid = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  addDmOptimistic(dmId, {
    id: `optimistic:${tempCmid}`,
    author: me,
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(reference ? { reference } : {}),
    createdAt,
    clientMessageId: tempCmid,
  });

  try {
    const { message, clientMessageId } = await sendDmMessage(sendClient, dmId, content, {
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(reference ? { reference } : {}),
    });
    // Reconcile the optimistic echo (matched on our temp client id) with the
    // canonical message, and stamp the real clientMessageId for cross-tab de-dupe.
    upsertDmMessage(dmId, {
      id: message.id,
      author: message.author,
      content: message.content,
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
      ...(message.reference ? { reference: message.reference } : {}),
      createdAt: message.createdAt,
      clientMessageId: tempCmid,
      mine: true,
    });
    // Persist the canonical sent message locally (the server keeps no copy).
    sentStore.append(dmId, {
      id: message.id,
      author: message.author,
      content: message.content,
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
      ...(message.reference ? { reference: message.reference } : {}),
      createdAt: message.createdAt,
      clientMessageId,
    });
    // Refresh the sidebar preview from this just-sent message.
    upsertConversation({
      dmId,
      counterparty,
      lastMessageText: message.content.text ?? "",
      updatedAt: message.createdAt,
    });
    return tempCmid;
  } catch (err) {
    markDmFailed(dmId, tempCmid);
    throw err;
  }
}

/** Retry a failed send: drop the failed echo and re-send its content. */
export async function retrySendDm(args: SendDmArgs & { clientMessageId: string }): Promise<string> {
  dropDmOptimistic(args.dmId, args.clientMessageId);
  return sendDm(args);
}

// ---------------------------------------------------------------------------
// Reactions / edit / delete / typing (REST + WS commands)
// ---------------------------------------------------------------------------

export interface DmReactionArgs {
  client: OfscpClient;
  /**
   * The RECIPIENT's provider client for a cross-provider conversation (built by
   * the caller via `clientForHost`, exactly as for {@link sendDm}). Omitted /
   * `undefined` for a same-provider recipient → the home `client` is used. Only
   * consulted for a message the caller SENT — see {@link deliveryClientFor}.
   */
  deliveryClient?: OfscpClient;
  dmId: string;
  messageId: string;
  /**
   * Who WROTE the message being reacted to (not who is reacting). §8.3 stores a
   * DM only in the recipient's inbox, so this — not the reacting actor — decides
   * which provider holds the copy the reaction attaches to.
   */
  messageAuthor: string;
  /** The reacting actor (the current user) — for the optimistic aggregate. */
  me: string;
  key: string;
  unicode?: string;
}

/**
 * Toggle the caller's reaction on a DM message: optimistically fold the change
 * into the local aggregate, then `PUT`/`DELETE` via a signed client.
 * The server fans `dm.reaction` back to BOTH participants (idempotent against the
 * aggregate), so the live confirmation is a no-op; on a REST failure we revert.
 *
 * The request goes to the provider that HOLDS the message ({@link deliveryClientFor}):
 * a message the caller RECEIVED sits in their own inbox on their home provider,
 * while one they SENT sits in the recipient's inbox on the RECIPIENT's provider
 * (§8.3) — which is also the only address that works for a conversation the
 * caller has only ever sent in, since their home provider stores nothing for it
 * and cannot learn the remote counterparty to forward to.
 */
export async function toggleDmReaction(args: DmReactionArgs & { has: boolean }): Promise<void> {
  const { client, dmId, messageId, messageAuthor, me, key, unicode, has } = args;
  const target = deliveryClientFor(client, args.deliveryClient, messageAuthor, me);
  if (has) {
    // Optimistic remove → DELETE; revert on failure.
    removeDmReactionAgg(dmId, messageId, key, me);
    try {
      await apiRemoveDmReaction(target, dmId, messageId, key);
    } catch (err) {
      addDmReactionAgg(dmId, optimisticReaction(messageId, me, key, unicode));
      throw err;
    }
    return;
  }
  // Optimistic add → PUT; revert on failure.
  addDmReactionAgg(dmId, optimisticReaction(messageId, me, key, unicode));
  try {
    await apiAddDmReaction(target, dmId, messageId, key);
  } catch (err) {
    removeDmReactionAgg(dmId, messageId, key, me);
    throw err;
  }
}

/** Build a canonical-shaped `Reaction` for an optimistic local aggregate fold. */
function optimisticReaction(
  messageId: string,
  author: string,
  key: string,
  unicode?: string,
): Reaction {
  return {
    id: `optimistic:${author}:${key}`,
    author,
    key,
    reference: { type: "message", id: messageId },
    createdAt: rfc3339Timestamp(),
    metadata: [],
    ...(unicode !== undefined ? { unicode } : {}),
  } as Reaction;
}

/**
 * Pick the client an operation on a message written by `messageAuthor` must be
 * addressed to, following §8.3 storage-follows-message:
 *
 *  - a message the caller **sent** is stored ONLY in the recipient's inbox, so
 *    the operation goes to the RECIPIENT's provider — the same delivery target
 *    `sendDm` resolves (`deliveryClient`, `undefined` when same-provider);
 *  - a message the caller **received** is stored in the caller's OWN inbox on
 *    their home provider (delete-from-my-inbox), so it goes to `client`.
 *
 * Note the target is decided by WHO WROTE the message, not by who is acting —
 * which matters for a reaction, where either participant may act on either
 * side's message: reacting to a message the caller RECEIVED stays on their home
 * provider, while reacting to one they SENT goes to the recipient's provider.
 *
 * Falls back to the home `client` whenever no delivery client was resolvable
 * (same-provider recipient, or no signing identity) — same shape as `sendDm`.
 */
function deliveryClientFor(
  client: OfscpClient,
  deliveryClient: OfscpClient | undefined,
  messageAuthor: string,
  me: string,
): OfscpClient {
  return messageAuthor === me ? (deliveryClient ?? client) : client;
}

/**
 * Thrown by {@link editDm} / {@link deleteDm} when the request failed in a way
 * that leaves the provider's outcome UNKNOWN — an aborted fetch (navigation), a
 * network drop, a 5xx — as opposed to a definitive 4xx refusal
 * (`isDefinitiveRejection`).
 *
 * On an unknown outcome the optimistic state is deliberately KEPT rather than
 * reverted. §8.3 leaves the author no server copy of a message they sent, so a
 * wrong revert used to be permanent: the author's retained copy would silently
 * diverge from the recipient's stored copy with nothing to re-sync from. Since
 * `GET /api/dms/{dmId}/messages` also returns the caller's OWN sent rows (§7.4),
 * the server copy reconciles the truth the next time the conversation is opened —
 * so keeping the optimistic state is strictly better than discarding a change
 * that may well have landed. The UI surfaces this as a distinct "couldn't
 * confirm" notice instead of the plain failure message.
 *
 * The underlying rejection is attached as `cause`.
 */
export class DmUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super("Could not confirm the change with the provider.", { cause });
    this.name = "DmUnconfirmedError";
  }
}

/**
 * Edit one of the caller's OWN DM messages in place.
 *
 * §8.3 reality: the author's sent copy is retained CLIENT-SIDE (the server keeps
 * no sender copy); the server's stored copy lives in the RECIPIENT's inbox. The
 * server routes the `PATCH` storage-follows-message: it edits the caller's own
 * inbox copy when one exists (a received copy or a self/same-node DM), else the
 * recipient's inbox copy — so the call SUCCEEDS instead of 404ing, and the
 * recipient receives the edit live over `dm.message`. We apply the edit
 * optimistically (own view + local sent-store, so it survives reload) and revert
 * it ONLY on a DEFINITIVE 4xx refusal (e.g. an expired edit window → 403), which
 * proves the edit did not land. Any other rejection — aborted fetch, network
 * drop, 5xx — is an unknown outcome: the optimistic state is KEPT and a
 * {@link DmUnconfirmedError} is thrown for the UI to distinguish.
 *
 * The request goes to the provider that HOLDS the message ({@link deliveryClientFor}):
 * for a message the caller SENT that is the recipient's provider (the same
 * delivery target `sendDm` uses, §8.3), otherwise the caller's home provider.
 */
export async function editDm(args: {
  client: OfscpClient;
  /**
   * The RECIPIENT's provider client for a cross-provider conversation (built by
   * the caller via `clientForHost`, exactly as for {@link sendDm}). Omitted /
   * `undefined` for a same-provider recipient → the home `client` is used.
   */
  deliveryClient?: OfscpClient;
  dmId: string;
  message: DmMessageLike;
  me: string;
  text: string;
  mime?: string;
  sentStore: DmSentStore;
}): Promise<void> {
  const { client, dmId, message, me, text, mime, sentStore } = args;
  const target = deliveryClientFor(client, args.deliveryClient, message.author, me);
  const content = { mime: mime ?? message.content.mime ?? "text/plain", text };
  /** The pre-edit snapshot, captured before the optimistic apply overwrites it. */
  const priorContent = {
    mime: message.content.mime ?? "text/plain",
    text: message.content.text ?? "",
  };
  const editedAt = rfc3339Timestamp();
  const mine = message.author === me;
  const attachmentsPart =
    message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {};
  const referencePart = message.reference ? { reference: message.reference } : {};

  // Optimistic apply: in-memory thread + local sent-store (survives reload).
  applyDmEdit(dmId, {
    id: message.id,
    author: message.author,
    content,
    ...attachmentsPart,
    ...referencePart,
    createdAt: message.createdAt,
    editedAt,
    mine,
  });
  sentStore.append(dmId, {
    id: message.id,
    author: message.author,
    content,
    ...attachmentsPart,
    ...referencePart,
    createdAt: message.createdAt,
    editedAt,
  });

  try {
    await editDmMessage(target, dmId, message.id, content);
  } catch (err) {
    // Unknown outcome (aborted fetch, network drop, 5xx): the server may well
    // have applied the edit, so KEEP the optimistic state — see
    // {@link DmUnconfirmedError} for why a wrong revert is the worse failure.
    if (!isDefinitiveRejection(err)) throw new DmUnconfirmedError(err);
    // Definitive 4xx (expired window, etc.): the edit did NOT land — rewind to
    // the prior snapshot so the author's view + local store stay truthful. Both
    // stores REPLACE rather than merge here, so the `editedAt` this call stamped
    // is actually removed (a merge would leave the message rendering "(edited)"
    // with its pre-edit text).
    restoreDmMessage(dmId, {
      id: message.id,
      content: priorContent,
      ...attachmentsPart,
      ...referencePart,
      ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
    });
    sentStore.restore(dmId, {
      id: message.id,
      author: message.author,
      content: priorContent,
      ...attachmentsPart,
      ...referencePart,
      createdAt: message.createdAt,
      ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
      ...(message.clientMessageId !== undefined
        ? { clientMessageId: message.clientMessageId }
        : {}),
    });
    throw err;
  }
}

/**
 * Delete (tombstone) a DM message. Like {@link editDm}, the server routes the
 * `DELETE` storage-follows-message, so it SUCCEEDS (tombstoning the copy that
 * actually exists) and the inbox owner receives it live over `dm.message`, and
 * the request is addressed to the provider that HOLDS the message
 * ({@link deliveryClientFor}). We tombstone optimistically (own view + local
 * sent-store) and — as in {@link editDm} — un-tombstone ONLY on a definitive 4xx
 * refusal; an unknown outcome keeps the tombstone and throws
 * {@link DmUnconfirmedError}.
 */
export async function deleteDm(args: {
  client: OfscpClient;
  /** As {@link editDm}: the RECIPIENT's provider client, cross-provider only. */
  deliveryClient?: OfscpClient;
  dmId: string;
  message: DmMessageLike;
  me: string;
  sentStore: DmSentStore;
}): Promise<void> {
  const { client, dmId, message, me, sentStore } = args;
  const target = deliveryClientFor(client, args.deliveryClient, message.author, me);
  const deletedAt = rfc3339Timestamp();
  /** The pre-delete snapshot, captured before the optimistic tombstone lands. */
  const priorContent = {
    mime: message.content.mime ?? "text/plain",
    text: message.content.text ?? "",
  };
  const attachmentsPart =
    message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {};
  const referencePart = message.reference ? { reference: message.reference } : {};

  // Optimistic tombstone: in-memory thread + local sent-store (survives reload).
  tombstoneDmMessage(dmId, message.id, deletedAt);
  sentStore.append(dmId, {
    id: message.id,
    author: message.author,
    content: { mime: "text/plain", text: "" },
    createdAt: message.createdAt,
    deletedAt,
  });

  try {
    await deleteDmMessage(target, dmId, message.id);
  } catch (err) {
    // Unknown outcome: the tombstone may already be the server's truth — keep it
    // (see {@link DmUnconfirmedError}).
    if (!isDefinitiveRejection(err)) throw new DmUnconfirmedError(err);
    // Definitive 4xx: the delete did NOT land — un-tombstone back to the prior
    // snapshot. Both stores REPLACE rather than merge, so `deletedAt` is actually
    // removed (a merge would leave the message rendering as a tombstone).
    restoreDmMessage(dmId, {
      id: message.id,
      content: priorContent,
      ...attachmentsPart,
      ...referencePart,
      ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
    });
    sentStore.restore(dmId, {
      id: message.id,
      author: message.author,
      content: priorContent,
      ...attachmentsPart,
      ...referencePart,
      createdAt: message.createdAt,
      ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
      ...(message.clientMessageId !== undefined
        ? { clientMessageId: message.clientMessageId }
        : {}),
    });
    throw err;
  }
}

/** The fields {@link editDm} / {@link deleteDm} read off the current message. */
export interface DmMessageLike {
  id: string;
  author: string;
  content: { mime?: string; text?: string };
  attachments?: Attachment[];
  reference?: { type: string; id: string };
  createdAt: string;
  /**
   * The message's CURRENT `editedAt`, if it was already edited before this call.
   * Carried so a revert rewinds to the true prior state rather than blanket-
   * clearing the marker off a message that legitimately had one.
   */
  editedAt?: string;
  /** Echo linkage on the retained sent copy — preserved across a revert. */
  clientMessageId?: string;
}

/** Throttle window for `typing.start` re-emits while composing (ms). */
export const DM_TYPING_THROTTLE_MS = 2500;
/** Idle window after the last keystroke before emitting `typing.stop` (ms). */
export const DM_TYPING_IDLE_MS = 3000;

/** Send a raw WS command frame (the client doesn't expose a generic sender). */
function sendDmCommand(ws: OfscpWsClient, type: string, data: Record<string, unknown>): void {
  const id = `${type.replace(/\W/g, "")}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  (ws as unknown as { sendRaw(frame: Record<string, unknown>): void }).sendRaw({
    id,
    type,
    ts: rfc3339Timestamp(),
    data,
  });
}

/** Signal the caller started typing in a DM (DM-scoped `{ dmId }`, §7.4). */
export function dmTypingStart(ws: OfscpWsClient, dmId: string): void {
  sendDmCommand(ws, "typing.start", { dmId });
}

/** Signal the caller stopped typing in a DM. */
export function dmTypingStop(ws: OfscpWsClient, dmId: string): void {
  sendDmCommand(ws, "typing.stop", { dmId });
}
