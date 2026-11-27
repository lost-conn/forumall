/** Errors shared by the DM send and mutation paths, and the notices the UI shows for them. */

/**
 * Thrown by {@link sendDm} / {@link editDm} / {@link deleteDm} when the request
 * failed in a way that leaves the provider's outcome UNKNOWN — an aborted fetch
 * (navigation), a network drop, a 5xx — as opposed to a definitive 4xx refusal
 * (`isDefinitiveRejection`).
 *
 * On an unknown outcome the optimistic state is deliberately KEPT rather than
 * reverted (edit/delete) or marked failed (send). §8.3 leaves the author no
 * server copy of a message they sent, so a wrong revert used to be permanent: the
 * author's retained copy would silently diverge from the recipient's stored copy
 * with nothing to re-sync from. Since `GET /api/dms/{dmId}/messages` also returns
 * the caller's OWN sent rows (§7.4), the server copy reconciles the truth the
 * next time the conversation is opened — so keeping the optimistic state is
 * strictly better than discarding a change that may well have landed. The UI
 * surfaces this as a distinct "couldn't confirm" notice instead of the plain
 * failure message.
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
 * Inline notice for an edit/delete whose outcome the provider never confirmed
 * (aborted fetch / network drop / 5xx). The optimistic change is deliberately
 * KEPT in that case (see `DmUnconfirmedError`), so the message stays as the user
 * left it and the server's copy reconciles on the next open — this text says so
 * rather than claiming the action failed.
 */
export const DM_UNCONFIRMED_NOTICE =
  "Couldn't confirm — this will reconcile when you reopen the conversation.";

/**
 * The same notice for a SEND whose outcome the provider never confirmed. The echo
 * deliberately stays "sending…" rather than flipping to "failed — retry" (see
 * `sendDm`): the message may already be in the recipient's inbox, and asserting a
 * failure we cannot observe is the worse lie. §7.4 reads return the caller's own
 * sent rows, so reopening the conversation shows the provider's copy.
 */
export const DM_UNCONFIRMED_SEND_NOTICE =
  "Couldn't confirm this send — it may have gone through. Reopen the conversation to see the provider's copy.";
