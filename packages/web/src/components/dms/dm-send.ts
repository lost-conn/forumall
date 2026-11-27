/**
 * Sending a DM (§7.4): `sendDm(...)` shows an optimistic echo, POSTs the
 * user-signed message to the RECIPIENT's provider, then on success persists the
 * canonical sent message to the local store AND reconciles the echo in place.
 * The recipient gets it via their inbox + a `dm.message`. One `clientMessageId`
 * per logical send keys BOTH the echo and the §7.1 idempotency check, so
 * `retrySendDm(...)` re-sends under the original id and a send that committed
 * without acknowledging is deduped rather than delivered twice.
 */
import type { Attachment } from "@forumall/shared";
import { newClientMessageId } from "../../lib/chat-api.ts";
import { putDmConversation, sendDmMessage } from "../../lib/dm-api.ts";
import type { DmSentStore } from "../../lib/dm-store.ts";
import { domainOf } from "../../lib/federation.ts";
import { mentionedActors } from "../../lib/mentions.ts";
import { type OfscpClient, isDefinitiveRejection } from "../../lib/ofscp-client.ts";
import {
  type DmMessage,
  addDmOptimistic,
  dropDmOptimistic,
  markDmFailed,
  upsertConversation,
  upsertDmMessage,
} from "../../stores/dms.ts";
import { DmUnconfirmedError } from "./dm-errors.ts";
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
  /**
   * Re-send under an EXISTING idempotency key instead of minting a fresh one —
   * how {@link retrySendDm} makes a retry safe. Omitted for a first send.
   */
  clientMessageId?: string;
  sentStore: DmSentStore;
}

/**
 * Send a DM: show an optimistic echo, POST the user-signed message, and on
 * success persist the canonical sent message locally + reconcile the echo.
 * Returns the `clientMessageId` the send used.
 *
 * ONE `clientMessageId` is minted per LOGICAL send (or reused from
 * `args.clientMessageId` on a retry) and serves both roles: it keys the
 * optimistic echo AND travels in the request body as the §7.1 idempotency key.
 * They used to be two different ids — a temporary `local_…` echo key here plus a
 * separate one minted inside `sendDmMessage` — which meant no id survived a
 * retry, so re-sending after an unacknowledged send delivered the message TWICE.
 * With one id the recipient's provider dedupes on
 * `(owner, dmId, author, clientMessageId)` and returns the first message instead.
 *
 * A DEFINITIVE 4xx marks the echo failed (the send certainly did not land, so the
 * retry affordance is honest). Any other rejection — aborted fetch, network drop,
 * 5xx — is an unknown outcome: the echo is left PENDING and a
 * {@link DmUnconfirmedError} is thrown for the UI to distinguish.
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
  // §5.3: the users the text names. The message is held by the recipient's
  // provider, so a bare `@handle` names a user there.
  const mentions = mentionedActors(text, domainOf(counterparty));
  const createdAt = new Date().toISOString();

  // The single id for this logical send: echo key + §7.1 idempotency key. A retry
  // passes the original one through so the server dedupes rather than duplicates.
  const clientMessageId = args.clientMessageId ?? newClientMessageId();
  addDmOptimistic(dmId, {
    id: `optimistic:${clientMessageId}`,
    author: me,
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(reference ? { reference } : {}),
    createdAt,
    clientMessageId,
  });

  try {
    const { message } = await sendDmMessage(sendClient, dmId, content, {
      to: counterparty,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(reference ? { reference } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      clientMessageId,
    });
    // Reconcile the optimistic echo with the canonical message: same id on both
    // sides, so the echo collapses in place instead of duplicating the row.
    upsertDmMessage(dmId, {
      id: message.id,
      author: message.author,
      content: message.content,
      ...(message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {}),
      ...(message.reference ? { reference: message.reference } : {}),
      createdAt: message.createdAt,
      clientMessageId,
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
    // Record the conversation pointer on our HOME provider (§7.4) so the
    // conversation lists on our other devices too. For a same-provider DM the
    // provider already did this on delivery; repeating it is idempotent.
    if (sendClient !== client) {
      void putDmConversation(client, dmId, counterparty, message).catch(() => undefined);
    }
    // Refresh the sidebar preview from this just-sent message.
    upsertConversation({
      dmId,
      counterparty,
      lastMessageText: message.content.text ?? "",
      updatedAt: message.createdAt,
    });
    return clientMessageId;
  } catch (err) {
    // Unknown outcome (aborted fetch, network drop, 5xx): the message may well be
    // in the recipient's inbox already, so DON'T claim it failed. The echo is left
    // exactly as it is — "sending…", the honest reading of "we never heard back" —
    // rather than flipped to "failed — retry", which would assert a delivery
    // failure we cannot observe. §7.4 reads return the caller's own sent rows, so
    // the provider's copy is what a reload of the conversation renders.
    if (!isDefinitiveRejection(err)) throw new DmUnconfirmedError(err);
    // Definitive 4xx: the provider refused, so nothing was stored — mark the echo
    // failed and offer the retry, which re-sends under this same id.
    markDmFailed(dmId, clientMessageId);
    throw err;
  }
}

/**
 * Retry a failed send: drop the failed echo and re-send its content under the
 * ORIGINAL `clientMessageId`.
 *
 * Reusing the id is what makes the retry safe. The §7.1 idempotency key is
 * `(owner, dmId, author, clientMessageId)`, so if the first attempt actually
 * committed and only its acknowledgement was lost, the recipient's provider
 * returns THAT message (200) and stores nothing new — where a freshly minted id
 * would deliver the message a second time.
 */
export async function retrySendDm(args: SendDmArgs & { clientMessageId: string }): Promise<string> {
  dropDmOptimistic(args.dmId, args.clientMessageId);
  return sendDm(args);
}

/** What a retry of a failed echo re-sends ({@link resendOf}). */
export type DmResend = Pick<SendDmArgs, "text" | "mime" | "attachments" | "reference"> & {
  clientMessageId: string;
};

/**
 * The message a retry of the failed echo `echo` re-sends: its own text under its
 * own `mime` (a Markdown body stays Markdown), attachments and reply pointer,
 * and its ORIGINAL `clientMessageId` ({@link retrySendDm}). `null` for a row
 * that is not an echo (no `clientMessageId`).
 */
export function resendOf(echo: DmMessage): DmResend | null {
  if (echo.clientMessageId === undefined) return null;
  return {
    text: echo.content.text ?? "",
    ...(echo.content.mime !== undefined ? { mime: echo.content.mime } : {}),
    ...(echo.attachments && echo.attachments.length > 0 ? { attachments: echo.attachments } : {}),
    ...(echo.reference ? { reference: echo.reference } : {}),
    clientMessageId: echo.clientMessageId,
  };
}
