/**
 * Reactions, edits and deletes on DM messages (REST, §7.4 / §8.3), each
 * addressed to the provider that HOLDS the message ({@link deliveryClientFor}).
 */
import type { Attachment, Reaction } from "@forumall/shared";
import { MessageSchema, rfc3339Timestamp } from "@forumall/shared";
import {
  addDmReaction as apiAddDmReaction,
  removeDmReaction as apiRemoveDmReaction,
  deleteDmMessage,
  editDmMessage,
} from "../../lib/dm-api.ts";
import type { DmSentStore } from "../../lib/dm-store.ts";
import { mentionedActors } from "../../lib/mentions.ts";
import { type OfscpClient, isDefinitiveRejection } from "../../lib/ofscp-client.ts";
import {
  type DmVersion,
  addDmReactionAgg,
  applyDmEdit,
  removeDmReactionAgg,
  tombstoneDmMessage,
} from "../../stores/dms.ts";
import { DmUnconfirmedError } from "./dm-errors.ts";
import { type DmMessageLike, beginDmMutation } from "./dm-mutation-chain.ts";

export type { DmMessageLike } from "./dm-mutation-chain.ts";
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
 * Edits and deletes of one message are ordered by `dm-mutation-chain.ts`: each
 * request waits for the earlier ones, the optimistic copy outranks every server
 * copy until the last of them settles, and then the settled version is
 * installed: the provider's answer (with the provider's `editedAt`), the kept
 * unconfirmed edit, or, after a rejection, the version before the rejected
 * edit. The optimistic copy is marked as a local version (`localVersion`, based
 * on the server version it edits), so the client's clock never orders it; a
 * kept unconfirmed edit is replaced by any later server copy of the message,
 * while a stale copy (an older history page) still cannot undo it
 * (`lib/merge-message.ts`).
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
  /** Display only: the copy is ordered by `localVersion`, never by this stamp. */
  const editedAt = rfc3339Timestamp();
  const edited: DmVersion = {
    content,
    ...(message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
    ...(message.reference ? { reference: message.reference } : {}),
    editedAt,
  };
  // §5.3 `mentions` is authoritative and §7.1 keeps a field the edit omits, so
  // resend it recomputed from the new text (`[]` once it names nobody). A bare
  // `@handle` names a user of the provider holding the message: `target`.
  const mentions = mentionedActors(text, target.host);
  const identity = { id: message.id, author: message.author, createdAt: message.createdAt };
  const mutation = beginDmMutation({ dmId, message, sentStore });

  // Optimistic apply: in-memory thread (unsettled, so no server copy undoes it
  // meanwhile) + local sent-store (survives reload).
  applyDmEdit(dmId, {
    ...identity,
    ...edited,
    localVersion: { ...mutation.basedOn, unsettled: true },
    mine: message.author === me,
  });
  sentStore.append(dmId, { ...identity, ...edited, localVersion: mutation.basedOn });

  let answer: unknown;
  try {
    await mutation.turn;
    answer = await editDmMessage(target, dmId, message.id, content, mentions);
  } catch (err) {
    // Unknown outcome (aborted fetch, network drop, 5xx): the server may well
    // have applied the edit, so KEEP the optimistic state — see
    // {@link DmUnconfirmedError} for why a wrong revert is the worse failure.
    if (!isDefinitiveRejection(err)) {
      mutation.settle({ kind: "unconfirmed", version: edited });
      throw new DmUnconfirmedError(err);
    }
    // Definitive 4xx (expired window, etc.): the edit did NOT land — the
    // settle rewinds both stores to the version before it.
    mutation.settle({ kind: "rejected" });
    throw err;
  }

  // The edit landed: the provider's stored copy is the settled version. An
  // answer that is not this message keeps the local version, to be confirmed
  // by the next server copy (a live `dm.message`, a history page).
  const confirmed = storedCopy(answer, message.id);
  mutation.settle(
    confirmed
      ? { kind: "confirmed", version: confirmed }
      : { kind: "unconfirmed", version: edited },
  );
}

/**
 * The version in a provider's answer to an edit of `messageId`: the stored
 * §5.3 message, or `null` when the answer is not a valid copy of it.
 */
function storedCopy(answer: unknown, messageId: string): DmVersion | null {
  const parsed = MessageSchema.safeParse(answer);
  if (!parsed.success || parsed.data.id !== messageId) return null;
  const m = parsed.data;
  return {
    content: m.content,
    ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
    ...(m.reference ? { reference: m.reference } : {}),
    ...(m.editedAt ? { editedAt: m.editedAt } : {}),
    ...(m.deletedAt ? { deletedAt: m.deletedAt } : {}),
  };
}

/**
 * Delete (tombstone) a DM message. Like {@link editDm}, the server routes the
 * `DELETE` storage-follows-message, so it SUCCEEDS (tombstoning the copy that
 * actually exists) and the inbox owner receives it live over `dm.message`, and
 * the request is addressed to the provider that HOLDS the message
 * ({@link deliveryClientFor}). We tombstone optimistically (own view + local
 * sent-store) and — as in {@link editDm} — un-tombstone ONLY on a definitive 4xx
 * refusal; an unknown outcome keeps the tombstone and throws
 * {@link DmUnconfirmedError}. It is ordered with the message's edits
 * (`dm-mutation-chain.ts`): sent after them, and a rejection rewinds to the
 * version they settled to.
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
  const tombstone: DmVersion = { content: { mime: "text/plain", text: "" }, deletedAt };
  const identity = { id: message.id, author: message.author, createdAt: message.createdAt };
  const mutation = beginDmMutation({ dmId, message, sentStore });

  // Optimistic tombstone: in-memory thread + local sent-store (survives reload).
  tombstoneDmMessage(dmId, message.id, deletedAt, { local: true });
  sentStore.append(dmId, { ...identity, ...tombstone });

  try {
    await mutation.turn;
    await deleteDmMessage(target, dmId, message.id);
  } catch (err) {
    // Unknown outcome: the tombstone may already be the server's truth — keep it
    // (see {@link DmUnconfirmedError}).
    if (!isDefinitiveRejection(err)) {
      mutation.settle({ kind: "unconfirmed", version: tombstone });
      throw new DmUnconfirmedError(err);
    }
    // Definitive 4xx: the delete did NOT land — the settle un-tombstones both
    // stores back to the version before it.
    mutation.settle({ kind: "rejected" });
    throw err;
  }
  mutation.settle({ kind: "confirmed", version: tombstone });
}
