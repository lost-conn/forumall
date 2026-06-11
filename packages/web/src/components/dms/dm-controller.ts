/**
 * DM controller (P8): the bridge between the live {@link OfscpWsClient}, the DM
 * REST surface, the local sent-store, and the reactive DM store for one open
 * conversation.
 *
 * `openConversation(...)` does the §7.4 dance:
 *   1. hydrate the merged thread with this user's locally-retained SENT messages
 *      (the server keeps no sender copy — §8.3),
 *   2. backfill RECEIVED history from the caller's inbox
 *      (`GET /api/dms/{dmId}/messages`, oldest-first) into the same thread,
 *   3. subscribe over WS with the `dm_` id and fold incoming `dm.message`
 *      (received) events into the thread live.
 * The store de-dupes received + sent by `id` and orders by `createdAt`.
 *
 * `sendDm(...)` shows an optimistic echo, POSTs the user-signed message, then on
 * success persists the canonical sent message to the local store AND reconciles
 * the echo in place. The recipient gets it via their inbox + a `dm.message`.
 */
import type {
  Attachment,
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
import type { DmSentStore } from "../../lib/dm-store.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import type { OfscpWsClient } from "../../lib/ofscp-ws.ts";
import {
  addDmOptimistic,
  addDmReactionAgg,
  applyDmEdit,
  dropDmOptimistic,
  markDmFailed,
  removeDmReactionAgg,
  setDmTyping,
  tombstoneDmMessage,
  upsertConversation,
  upsertDmMessage,
} from "../../stores/dms.ts";

/** History page size for the inbox backfill. */
export const DM_HISTORY_PAGE_SIZE = 50;

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
  /** Tear down the WS listener + unsubscribe (thread switch / unmount). */
  close(): void;
}

/**
 * Open a conversation: hydrate local sent history, backfill received inbox
 * history, subscribe with the `dm_` id, and fold live `dm.message` events into
 * the store. Returns a handle for teardown.
 */
export async function openConversation(deps: OpenConversationDeps): Promise<ConversationHandle> {
  const { client, ws, dmId, me, counterparty, sentStore } = deps;

  // Remember the counterparty so an only-sent conversation still lists it.
  sentStore.rememberCounterparty(dmId, counterparty);

  // 1) Hydrate THIS user's locally-retained sent messages (no server copy). A
  // sent message the author edited/deleted carries those markers locally (own
  // copies are client-retained, §8.3) — restore them so reload reflects the edit
  // / tombstone.
  for (const sent of sentStore.list(dmId)) {
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
      ...(sent.attachments && sent.attachments.length > 0 ? { attachments: sent.attachments } : {}),
      ...(sent.reference ? { reference: sent.reference } : {}),
      createdAt: sent.createdAt,
      ...(sent.editedAt ? { editedAt: sent.editedAt } : {}),
      ...(sent.clientMessageId !== undefined ? { clientMessageId: sent.clientMessageId } : {}),
      mine: true,
    });
  }

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

  // 4) Backfill RECEIVED inbox history (oldest-first so order is chronological).
  // A brand-new conversation the caller has only SENT to has no inbox row → 404;
  // that's expected (the local sent history still renders).
  try {
    let cursor: string | undefined;
    // Page forward through the whole inbox for this conversation.
    for (;;) {
      const page = await fetchDmMessages(client, dmId, {
        ...(cursor ? { cursor } : {}),
        limit: DM_HISTORY_PAGE_SIZE,
        direction: "forward",
      });
      for (const m of page.messages) {
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
      if (!page.nextCursor || page.messages.length === 0) break;
      cursor = page.nextCursor;
    }
  } catch (err) {
    // A 404 means no inbox conversation row yet (only-sent or empty) — fine.
    if (
      !(
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status: number }).status === 404
      )
    ) {
      throw err;
    }
  }

  return {
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
  dmId: string;
  messageId: string;
  /** The reacting actor (the current user) — for the optimistic aggregate. */
  me: string;
  key: string;
  unicode?: string;
}

/**
 * Toggle the caller's reaction on a DM message: optimistically fold the change
 * into the local aggregate, then `PUT`/`DELETE` via the signed session client.
 * The server fans `dm.reaction` back to BOTH participants (idempotent against the
 * aggregate), so the live confirmation is a no-op; on a REST failure we revert.
 */
export async function toggleDmReaction(args: DmReactionArgs & { has: boolean }): Promise<void> {
  const { client, dmId, messageId, me, key, unicode, has } = args;
  if (has) {
    // Optimistic remove → DELETE; revert on failure.
    removeDmReactionAgg(dmId, messageId, key, me);
    try {
      await apiRemoveDmReaction(client, dmId, messageId, key);
    } catch (err) {
      addDmReactionAgg(dmId, optimisticReaction(messageId, me, key, unicode));
      throw err;
    }
    return;
  }
  // Optimistic add → PUT; revert on failure.
  addDmReactionAgg(dmId, optimisticReaction(messageId, me, key, unicode));
  try {
    await apiAddDmReaction(client, dmId, messageId, key);
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
 * Edit one of the caller's OWN DM messages in place.
 *
 * §8.3 reality: the author's sent copy is retained CLIENT-SIDE (the server keeps
 * no sender copy); the server's stored copy lives in the RECIPIENT's inbox. The
 * server now routes the `PATCH` storage-follows-message: it edits the caller's
 * own inbox copy when one exists (a self-DM), else applies/forwards the edit to
 * the recipient's inbox copy — so the call SUCCEEDS instead of 404ing, and the
 * recipient receives the edit live over `dm.message`. We apply the edit
 * optimistically (own view + local sent-store, so it survives reload) and revert
 * on a genuine REST failure (e.g. an expired edit window → 403).
 */
export async function editDm(args: {
  client: OfscpClient;
  dmId: string;
  message: DmMessageLike;
  me: string;
  text: string;
  mime?: string;
  sentStore: DmSentStore;
}): Promise<void> {
  const { client, dmId, message, me, text, mime, sentStore } = args;
  const content = { mime: mime ?? message.content.mime ?? "text/plain", text };
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
    await editDmMessage(client, dmId, message.id, content);
  } catch (err) {
    // Genuine failure (expired window, etc.): revert the optimistic edit back to
    // the prior content so the author's view + local store stay truthful.
    applyDmEdit(dmId, {
      id: message.id,
      author: message.author,
      content: { mime: message.content.mime ?? "text/plain", text: message.content.text ?? "" },
      ...attachmentsPart,
      ...referencePart,
      createdAt: message.createdAt,
      mine,
    });
    sentStore.append(dmId, {
      id: message.id,
      author: message.author,
      content: { mime: message.content.mime ?? "text/plain", text: message.content.text ?? "" },
      ...attachmentsPart,
      ...referencePart,
      createdAt: message.createdAt,
    });
    throw err;
  }
}

/**
 * Delete (tombstone) one of the caller's OWN DM messages. Like {@link editDm},
 * the server now routes the `DELETE` storage-follows-message, so it SUCCEEDS
 * (applying / forwarding the tombstone to the recipient's inbox copy) and the
 * recipient receives it live over `dm.message`. We tombstone optimistically (own
 * view + local sent-store) and revert on a genuine failure.
 */
export async function deleteDm(args: {
  client: OfscpClient;
  dmId: string;
  message: DmMessageLike;
  me: string;
  sentStore: DmSentStore;
}): Promise<void> {
  const { client, dmId, message, me, sentStore } = args;
  const deletedAt = rfc3339Timestamp();

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
    await deleteDmMessage(client, dmId, message.id);
  } catch (err) {
    // Genuine failure: restore the message to its prior content (un-tombstone).
    upsertDmMessage(dmId, {
      id: message.id,
      author: message.author,
      content: { mime: message.content.mime ?? "text/plain", text: message.content.text ?? "" },
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
      ...(message.reference ? { reference: message.reference } : {}),
      createdAt: message.createdAt,
      mine: message.author === me,
    });
    sentStore.append(dmId, {
      id: message.id,
      author: message.author,
      content: { mime: message.content.mime ?? "text/plain", text: message.content.text ?? "" },
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
      ...(message.reference ? { reference: message.reference } : {}),
      createdAt: message.createdAt,
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
