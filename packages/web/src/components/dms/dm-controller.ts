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
import type { WsDmMessage, WsEnvelope } from "@forumall/shared";
import { fetchDmMessages, sendDmMessage } from "../../lib/dm-api.ts";
import type { DmSentStore } from "../../lib/dm-store.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import type { OfscpWsClient } from "../../lib/ofscp-ws.ts";
import {
  addDmOptimistic,
  dropDmOptimistic,
  markDmFailed,
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

  // 1) Hydrate THIS user's locally-retained sent messages (no server copy).
  for (const sent of sentStore.list(dmId)) {
    upsertDmMessage(dmId, {
      id: sent.id,
      author: sent.author,
      content: sent.content,
      createdAt: sent.createdAt,
      ...(sent.clientMessageId !== undefined ? { clientMessageId: sent.clientMessageId } : {}),
      mine: true,
    });
  }

  // 2) Wire the live `dm.message` listener BEFORE subscribing so no event is
  // missed. Filter to THIS conversation by `dmId` (the event carries `dmId`, not
  // a `channelId`). Received messages are authored by the counterparty; our own
  // sent messages never come back over this channel (no sender copy).
  const offDm = ws.on("dm.message", (e: WsEnvelope) => {
    const data = (e as WsDmMessage).data;
    if (data.dmId !== dmId) return;
    const m = data.message;
    const mine = m.author === me;
    upsertDmMessage(dmId, {
      id: m.id,
      author: m.author,
      content: m.content,
      createdAt: m.createdAt,
      ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
      mine,
    });
    // Keep the sidebar preview fresh on live receipt.
    upsertConversation({
      dmId,
      counterparty,
      lastMessageText: m.content.text ?? "",
      updatedAt: m.createdAt,
    });
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
        upsertDmMessage(dmId, {
          id: m.id,
          author: m.author,
          content: m.content,
          createdAt: m.createdAt,
          mine: m.author === me,
        });
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
    createdAt,
    clientMessageId: tempCmid,
  });

  try {
    const { message, clientMessageId } = await sendDmMessage(sendClient, dmId, content);
    // Reconcile the optimistic echo (matched on our temp client id) with the
    // canonical message, and stamp the real clientMessageId for cross-tab de-dupe.
    upsertDmMessage(dmId, {
      id: message.id,
      author: message.author,
      content: message.content,
      createdAt: message.createdAt,
      clientMessageId: tempCmid,
      mine: true,
    });
    // Persist the canonical sent message locally (the server keeps no copy).
    sentStore.append(dmId, {
      id: message.id,
      author: message.author,
      content: message.content,
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
