/**
 * Timeline heads (OFSCP §7.7 auto-mark-read): per open scope (`chn_…` channel id
 * or `dmId`), the id of the newest message the provider has delivered as part
 * of the scope's timeline — the message a view marks read.
 *
 * The loaded message list cannot answer "which is newest": it also holds
 * messages loaded out of timeline order (a reply listing, an edit to a message
 * outside the loaded window, a backward history page), and the client never
 * decodes cursors to sort them (§2.5). Only the controllers know which arrivals
 * ARE the timeline's front, so they record them here:
 *
 *  - {@link resetTimelineHead} when a scope is opened (before subscribing);
 *  - {@link advanceTimelineHead} for each live or resumed create, which the
 *    provider delivers in commit order (§7.1), so the latest one is the newest;
 *  - {@link settleTimelineHead} with the newest history page
 *    (`headAfterNewestPage` decides whether it or a live create is newer).
 *
 * Older history pages, reply listings and edits never move a head.
 */
import { createStore, reconcile } from "solid-js/store";
import { headAfterNewestPage } from "../lib/read-position.ts";

const [heads, setHeads] = createStore<Record<string, string | undefined>>({});

/** Forget `scopeId`'s head: the scope is being (re)opened. */
export function resetTimelineHead(scopeId: string): void {
  setHeads(scopeId, undefined);
}

/** A live or resumed create for `scopeId` delivered `messageId`: it is the head. */
export function advanceTimelineHead(scopeId: string, messageId: string): void {
  setHeads(scopeId, messageId);
}

/**
 * The scope's newest history page arrived, its ids newest first (only messages
 * a head may name): settle the head between it and any live create recorded
 * since the scope was opened.
 */
export function settleTimelineHead(scopeId: string, pageNewestFirst: readonly string[]): void {
  const next = headAfterNewestPage(heads[scopeId], pageNewestFirst);
  if (next !== undefined) setHeads(scopeId, next);
}

/** The scope's timeline head (reactive), or `undefined` before anything arrived. */
export function timelineHeadFor(scopeId: string): string | undefined {
  return heads[scopeId];
}

/** Forget every head (logout). */
export function clearTimelineHeads(): void {
  setHeads(reconcile({}));
}
