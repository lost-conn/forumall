/**
 * Per-message ordering of the caller's optimistic DM edits and deletes
 * (`dm-mutations.ts`).
 *
 * Two edits of one message in quick succession must end on the SECOND, on
 * screen and on the provider, however their answers and the live `dm.message`
 * copies interleave. So, per message:
 *
 * - Requests are serialized: a mutation's request is sent only once every
 *   earlier mutation of the message has settled ({@link DmMutation.turn}). The
 *   provider therefore applies them in the order the user made them, and its
 *   last version is the user's last edit.
 * - Each optimistic copy is UNSETTLED (`localVersion.unsettled`) until the last
 *   mutation of the message settles. An unsettled copy outranks every server
 *   copy (`lib/merge-message.ts`), so neither the first edit's answer nor a
 *   late or out-of-order `dm.message` can put the first edit back on screen
 *   while the second is pending. Server copies arriving meanwhile are kept
 *   aside (`DmMessage.serverCopy`).
 * - The chain tracks the version the message settles to: the provider's copy
 *   of the latest confirmed mutation, the latest unconfirmed one (kept, ordered
 *   by the version it was based on), or, while every mutation so far was
 *   rejected, the version before them. When the last unsettled mutation
 *   settles, that version (or a newer server copy kept aside) is installed in
 *   the thread and the sent store, so a rejected second edit rolls back to the
 *   confirmed first one.
 * - Meanwhile the sent store holds the user's LATEST mutation, so a reload
 *   mid-chain still shows it. Server copies of the message are not merged into
 *   the sent store while it is unsettled ({@link hasUnsettledDmMutation}); and
 *   when an earlier edit is confirmed, the retained later edit is re-based on
 *   the confirmed version (the provider applies it over that one), so after a
 *   reload the earlier edit's server copy cannot replace it, while the later
 *   edit's own copy, or any newer one, still does.
 */
import type { DmSentStore } from "../../lib/dm-store.ts";
import { type LocalVersion, localVersionOf } from "../../lib/merge-message.ts";
import { type DmVersion, dmVersionOf, settleDmMessage } from "../../stores/dms.ts";

/** The fields `editDm` / `deleteDm` read off the current message. */
export interface DmMessageLike extends DmVersion {
  id: string;
  author: string;
  createdAt: string;
  /** Echo linkage on the retained sent copy, preserved when it is rebuilt. */
  clientMessageId?: string;
}

/** How one mutation's request ended. */
export type DmMutationOutcome =
  /** The provider applied it; `version` is its stored copy. */
  | { kind: "confirmed"; version: DmVersion }
  /** Unknown outcome (or an answer that is not the message): keep `version`. */
  | { kind: "unconfirmed"; version: DmVersion }
  /** A definitive refusal: the mutation did not land. */
  | { kind: "rejected" };

/** One optimistic mutation of a message, from its local apply to its settle. */
export interface DmMutation {
  /** The base for this mutation's optimistic copy (see `LocalVersion.basedOn`). */
  readonly basedOn: LocalVersion;
  /** Resolves when every earlier mutation of the message has settled. */
  readonly turn: Promise<void>;
  /**
   * Record how the request ended. When no other mutation of the message is
   * unsettled, installs the settled version in the thread and the sent store.
   * Call exactly once.
   */
  settle(outcome: DmMutationOutcome): void;
}

interface Chain {
  /** The version the message settles to if no unsettled mutation lands. */
  settled: DmVersion;
  /** Mutations begun and not yet settled. */
  unsettled: number;
  /** Resolves when the newest mutation settles: the next one's turn. */
  tail: Promise<void>;
}

const chains = new Map<string, Chain>();

/** The {@link chains} key of a message. */
function chainKey(dmId: string, messageId: string): string {
  return `${dmId}\u0000${messageId}`;
}

/** Whether a mutation of the message is begun and not yet settled. */
export function hasUnsettledDmMutation(dmId: string, messageId: string): boolean {
  return chains.has(chainKey(dmId, messageId));
}

/**
 * Begin an optimistic mutation of `message` in `dmId`. Call it before the
 * optimistic apply, send the request after `turn`, and `settle` it once.
 */
export function beginDmMutation(args: {
  dmId: string;
  message: DmMessageLike;
  sentStore: DmSentStore;
}): DmMutation {
  const { dmId, sentStore } = args;
  const { id, author, createdAt, clientMessageId } = args.message;
  const key = chainKey(dmId, id);
  let chain = chains.get(key);
  if (chain === undefined) {
    // Detached now: `message` may be the thread's stored object, which the
    // optimistic apply merges into in place.
    chain = { settled: dmVersionOf(args.message), unsettled: 0, tail: Promise.resolve() };
    chains.set(key, chain);
  }
  const own = chain;
  own.unsettled += 1;
  const turn = own.tail;
  let release = (): void => {};
  own.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;

  return {
    basedOn: localVersionOf(own.settled),
    turn,
    settle(outcome) {
      if (settled) throw new Error("a DM mutation settles once");
      settled = true;
      if (outcome.kind === "confirmed") {
        own.settled = dmVersionOf(outcome.version);
      } else if (outcome.kind === "unconfirmed") {
        const version = dmVersionOf(outcome.version);
        // A kept edit is ordered by the version it was sent over; a tombstone
        // is terminal and needs no order.
        own.settled =
          version.deletedAt !== undefined
            ? version
            : { ...version, localVersion: localVersionOf(own.settled) };
      }
      own.unsettled -= 1;
      release();
      if (own.unsettled > 0) {
        // A later mutation is still pending: the provider applies it over this
        // version, so the retained copy of it is now based on this one.
        if (outcome.kind === "confirmed") {
          sentStore.rebaseLocalEdit(dmId, id, localVersionOf(own.settled));
        }
        return;
      }
      chains.delete(key);
      const installed = settleDmMessage(dmId, id, own.settled) ?? own.settled;
      sentStore.restore(dmId, {
        id,
        author,
        createdAt,
        ...installed,
        ...(clientMessageId !== undefined ? { clientMessageId } : {}),
      });
    },
  };
}
