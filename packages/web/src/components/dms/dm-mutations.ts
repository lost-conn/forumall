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
import {
  type DmMessageLike,
  type DmMutation,
  type DmMutationOutcome,
  beginDmMutation,
} from "./dm-mutation-chain.ts";

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
 * How long one edit or delete request may take before its outcome counts as
 * unknown (a `TimeoutError`, {@link DmUnconfirmedError}). Every later mutation
 * of the message waits for it (`dm-mutation-chain.ts`), so a hung request must
 * not hold them forever. Longer than the client's `Retry-After` budget
 * (`DEFAULT_RETRY_MAX_WAIT_MS`), so a provider warming up is still waited out.
 */
export const DM_MUTATION_TIMEOUT_MS = 30_000;

/**
 * The RECIPIENT's provider client for a cross-provider conversation (built via
 * `clientForHost`, exactly as for {@link sendDm}), `null`/`undefined` for a
 * same-provider recipient (the home client is used). It may still be resolving
 * (the device key is read from IndexedDB): the mutation joins the message's
 * order when it is called, and the client is awaited only when its turn comes.
 */
export type DmDeliveryClient = OfscpClient | null | undefined;

/** The arguments {@link editDm} and {@link deleteDm} share. */
interface DmMutationArgs {
  client: OfscpClient;
  /** See {@link DmDeliveryClient}. */
  deliveryClient?: DmDeliveryClient | Promise<DmDeliveryClient>;
  dmId: string;
  message: DmMessageLike;
  me: string;
  sentStore: DmSentStore;
  /** Bound on the request, in ms. Default {@link DM_MUTATION_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Where a mutation's request goes, once known, or why that is not known. */
type Target = { ok: true; client: OfscpClient } | { ok: false; error: unknown };

/**
 * The client a mutation of `message` is addressed to ({@link deliveryClientFor}),
 * as a promise that never rejects: it is awaited only after the mutation's turn,
 * and a failure to resolve it is the mutation's own rejection.
 */
function mutationTarget(args: DmMutationArgs): Promise<Target> {
  const { client, message, me } = args;
  return Promise.resolve(args.deliveryClient).then(
    (delivery): Target => ({
      ok: true,
      client: deliveryClientFor(client, delivery ?? undefined, message.author, me),
    }),
    (error: unknown): Target => ({ ok: false, error }),
  );
}

/**
 * Run one optimistic mutation from its local apply to its settle, which is
 * GUARANTEED: whatever throws after {@link beginDmMutation} (the optimistic
 * apply, a full `localStorage`, resolving the target, the request), the
 * mutation settles exactly once, so the message's later mutations are never
 * left waiting and no unsettled copy is left outranking every server copy.
 *
 * The outcome: `send`'s, or `kept` as unconfirmed when the request fails with
 * an unknown outcome (aborted, network drop, timeout, 5xx; thrown as
 * {@link DmUnconfirmedError}), or rejected for a definitive 4xx and for any
 * failure before the request was sent (it certainly did not land).
 */
async function runDmMutation(steps: {
  mutation: DmMutation;
  target: Promise<Target>;
  kept: DmVersion;
  apply(): void;
  send(target: OfscpClient): Promise<DmMutationOutcome>;
}): Promise<void> {
  const { mutation } = steps;
  let outcome: DmMutationOutcome = { kind: "rejected" };
  try {
    steps.apply();
    await mutation.turn;
    const target = await steps.target;
    if (!target.ok) throw target.error;
    try {
      outcome = await steps.send(target.client);
    } catch (err) {
      // Unknown outcome: the server may well have applied it, so KEEP the
      // optimistic state — see {@link DmUnconfirmedError} for why a wrong
      // revert is the worse failure. A definitive 4xx did NOT land: the
      // rejected settle rewinds both stores to the version before it.
      if (isDefinitiveRejection(err)) throw err;
      outcome = { kind: "unconfirmed", version: steps.kept };
      throw new DmUnconfirmedError(err);
    }
  } finally {
    mutation.settle(outcome);
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
 * drop, timeout ({@link DM_MUTATION_TIMEOUT_MS}), 5xx — is an unknown outcome:
 * the optimistic state is KEPT and a {@link DmUnconfirmedError} is thrown for
 * the UI to distinguish. Either way the message has settled (and its row shows
 * the settled version) by the time the promise rejects.
 *
 * Edits and deletes of one message are ordered by `dm-mutation-chain.ts`, in the
 * order of the calls: the mutation joins the message's chain synchronously, when
 * `editDm` is called (so call it at submit time; a still-resolving
 * `deliveryClient` is awaited only once its turn comes). Each request waits for
 * the earlier ones, the optimistic copy outranks every server copy until the
 * last of them settles, and then the settled version is installed: the
 * provider's answer (with the provider's `editedAt`), the kept unconfirmed edit,
 * or, after a rejection, the version before the rejected edit. The optimistic
 * copy is marked as a local version (`localVersion`, based on the server
 * version it edits), so the client's clock never orders it; a kept unconfirmed
 * edit is replaced by any later server copy of the message, while a stale copy
 * (an older history page) still cannot undo it (`lib/merge-message.ts`).
 *
 * The request goes to the provider that HOLDS the message ({@link deliveryClientFor}):
 * for a message the caller SENT that is the recipient's provider (the same
 * delivery target `sendDm` uses, §8.3), otherwise the caller's home provider.
 */
export async function editDm(
  args: DmMutationArgs & { text: string; mime?: string },
): Promise<void> {
  const { dmId, message, me, text, mime, sentStore } = args;
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
  const identity = { id: message.id, author: message.author, createdAt: message.createdAt };
  const target = mutationTarget(args);
  const mutation = beginDmMutation({ dmId, message, sentStore });

  await runDmMutation({
    mutation,
    target,
    kept: edited,
    apply() {
      // In-memory thread (unsettled, so no server copy undoes it meanwhile) +
      // local sent-store (survives reload).
      applyDmEdit(dmId, {
        ...identity,
        ...edited,
        localVersion: { ...mutation.basedOn, unsettled: true },
        mine: message.author === me,
      });
      sentStore.append(dmId, { ...identity, ...edited, localVersion: mutation.basedOn });
    },
    async send(client) {
      // §5.3 `mentions` is authoritative and §7.1 keeps a field the edit omits,
      // so resend it recomputed from the new text (`[]` once it names nobody). A
      // bare `@handle` names a user of the provider holding the message.
      const mentions = mentionedActors(text, client.host);
      const answer = await editDmMessage(client, dmId, message.id, content, mentions, {
        timeoutMs: args.timeoutMs ?? DM_MUTATION_TIMEOUT_MS,
      });
      // The edit landed: the provider's stored copy is the settled version. An
      // answer that is not this message keeps the local version, to be
      // confirmed by the next server copy (a live `dm.message`, a history page).
      const confirmed = storedCopy(answer, message.id);
      return confirmed
        ? { kind: "confirmed", version: confirmed }
        : { kind: "unconfirmed", version: edited };
    },
  });
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
 * {@link DmUnconfirmedError}. It joins the message's order when called, like
 * {@link editDm} (`dm-mutation-chain.ts`): sent after the edits made before it,
 * and a rejection rewinds to the version they settled to.
 */
export async function deleteDm(args: DmMutationArgs): Promise<void> {
  const { dmId, message, sentStore } = args;
  const deletedAt = rfc3339Timestamp();
  const tombstone: DmVersion = { content: { mime: "text/plain", text: "" }, deletedAt };
  const identity = { id: message.id, author: message.author, createdAt: message.createdAt };
  const target = mutationTarget(args);
  const mutation = beginDmMutation({ dmId, message, sentStore });

  await runDmMutation({
    mutation,
    target,
    kept: tombstone,
    apply() {
      // In-memory thread + local sent-store (survives reload).
      tombstoneDmMessage(dmId, message.id, deletedAt, { local: true });
      sentStore.append(dmId, { ...identity, ...tombstone });
    },
    async send(client) {
      await deleteDmMessage(client, dmId, message.id, {
        timeoutMs: args.timeoutMs ?? DM_MUTATION_TIMEOUT_MS,
      });
      return { kind: "confirmed", version: tombstone };
    },
  });
}
