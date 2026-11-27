/**
 * The read-marker store's record of its OWN marks (OFSCP §7.7), which decides
 * whether a provider report for a scope may replace the local state.
 *
 * A marker is a message id and the client never decodes cursors (§2.5), so it
 * cannot compare two reports by position. It can order them in time instead:
 * every mark, every mark's settling (its PATCH answered or failed) and every
 * summary request takes the next tick of one local clock.
 *
 *  - A **summary** (`GET`) is a snapshot taken somewhere between its issue and
 *    its answer. Issued before a scope's latest mark settled, it may predate
 *    that mark's commit, so its entry for the scope is skipped — including one
 *    answered after the mark's PATCH answer. Issued after it settled, the
 *    provider had already committed (or refused) the mark, so it applies.
 *  - A **`read.updated`** carries no request time, but the provider emits it in
 *    commit order. One naming the latest mark confirms it. While the latest mark
 *    is pending, any other report is older than it. Once it settled, a report
 *    naming one of this device's EARLIER marks was committed before the latest
 *    one (an earlier PATCH is committed first or not at all), so it is stale;
 *    any other message is another device's advance and applies.
 *
 * Earlier marks are remembered only until a `read.updated` shows their events
 * are past: one naming a mark means every report for earlier marks has already
 * arrived (commit order), so those, and it, are forgotten.
 */

/** The newest mark made for a scope. */
interface LatestMark {
  messageId: string;
  stamp: number;
  /** Clock tick at which its PATCH was answered or failed; unset while pending. */
  settledAt?: number;
}

export class ReadMarkLedger {
  private clock = 0;
  private readonly latest = new Map<string, LatestMark>();
  /** scopeId → earlier marks (messageId → stamp), oldest first. */
  private readonly earlier = new Map<string, Map<string, number>>();

  /** Record a new mark of `messageId` in `scopeId`; returns its stamp. */
  mark(scopeId: string, messageId: string): number {
    const stamp = this.tick();
    const prev = this.latest.get(scopeId);
    if (prev) {
      const earlier = this.earlier.get(scopeId) ?? new Map<string, number>();
      // Re-inserting moves the id to the end, keeping the map in stamp order.
      earlier.delete(prev.messageId);
      earlier.set(prev.messageId, prev.stamp);
      this.earlier.set(scopeId, earlier);
    }
    this.earlier.get(scopeId)?.delete(messageId);
    this.latest.set(scopeId, { messageId, stamp });
    return stamp;
  }

  /**
   * The PATCH for the mark stamped `stamp` was answered or failed. Returns
   * whether it is still the scope's latest mark (an earlier one settling
   * changes nothing).
   */
  settle(scopeId: string, stamp: number): boolean {
    const latest = this.latest.get(scopeId);
    if (latest?.stamp !== stamp) return false;
    latest.settledAt = this.tick();
    return true;
  }

  /** Whether the scope's latest mark is still waiting for its PATCH answer. */
  pending(scopeId: string): boolean {
    const latest = this.latest.get(scopeId);
    return latest !== undefined && latest.settledAt === undefined;
  }

  /** The clock tick to stamp a summary request with, taken as it is issued. */
  issueSummary(): number {
    return this.tick();
  }

  /** Whether a summary issued at `issuedAt` may set `scopeId` to `messageId`. */
  summaryApplies(scopeId: string, messageId: string | undefined, issuedAt: number): boolean {
    const latest = this.latest.get(scopeId);
    if (!latest || latest.messageId === messageId) return true;
    return latest.settledAt !== undefined && issuedAt > latest.settledAt;
  }

  /**
   * Whether a `read.updated` setting `scopeId` to `messageId` may apply. Also
   * forgets the earlier marks the report shows are past.
   */
  updateApplies(scopeId: string, messageId: string | undefined): boolean {
    const latest = this.latest.get(scopeId);
    if (!latest) return true;
    if (latest.messageId === messageId) {
      this.earlier.delete(scopeId);
      return true;
    }
    const earlier = this.earlier.get(scopeId);
    if (messageId !== undefined && earlier?.has(messageId)) {
      for (const id of [...earlier.keys()]) {
        earlier.delete(id);
        if (id === messageId) break;
      }
      return false;
    }
    return latest.settledAt !== undefined;
  }

  /** Scopes whose latest mark a summary issued at `issuedAt` may not cover. */
  *unsettledSince(issuedAt: number): Iterable<string> {
    for (const [scopeId, m] of this.latest) {
      if (m.settledAt === undefined || m.settledAt > issuedAt) yield scopeId;
    }
  }

  /** Forget everything (logout). */
  clear(): void {
    this.latest.clear();
    this.earlier.clear();
  }

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }
}
