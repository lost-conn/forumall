/**
 * Read-marker store (OFSCP §7.7).
 *
 * Holds, per scope (`chn_…` channel id OR a `dmId`), the newest message the user
 * has read (`lastReadMessageId`, absent if none) and the provider-computed
 * `unreadCount`. The store is the single source of truth for unread badges
 * (space rail, channel list, DM list) and the "New messages" divider's anchor.
 *
 *  - {@link hydrateReadMarkers} pulls the full summary on session start.
 *  - {@link markRead} optimistically moves a scope's marker to a message and
 *    zeros its unread count, then PATCHes the spec body
 *    `{ markers: [{ scopeId, lastReadMessageId }] }`.
 *  - {@link applyReadUpdated} folds an inbound `read.updated` WS event (a
 *    marker advanced, on this device or another) into the store.
 *  - {@link installReadMarkerListener} wires the single `read.updated` listener
 *    onto the home WS client (idempotent), mirroring the presence controller.
 *
 * ## Ordering
 * A marker is a message id, and the client never decodes cursors to compare
 * positions (§2.5). The provider keeps markers monotonic and reports only real
 * advances, and `read.updated` events arrive in the order it committed them.
 * What the client must still guard is its OWN optimistic mark: a mark that is
 * still waiting for its PATCH answer is newer than anything the provider has
 * reported so far, so while it is pending the store keeps it against every
 * other report for that scope — a late `read.updated` for an earlier mark, or
 * a summary read before the PATCH landed — instead of letting the marker move
 * back. The answer then settles the scope: applied if the mark advanced,
 * re-read from the summary if it did not (the provider held a newer marker, set
 * by another device, or ignored the message). A report naming the pending
 * message itself is its confirmation and applies. The views pick which message
 * to mark from the scope's timeline head (`stores/timeline-heads.ts`).
 */
import type { ReadMarker } from "@forumall/shared";
import { createStore, reconcile } from "solid-js/store";
import type { OfscpWsClient } from "../lib/ofscp-ws.ts";
import { getReadMarkers, setReadMarkers as patchReadMarkers } from "../lib/read-markers-api.ts";
import type { ReadSnapshot } from "../lib/read-position.ts";
import { sessionClient } from "./session.ts";

/** Per-scope read state. */
export interface ScopeReadState {
  /** The newest message read in this scope; absent if nothing has been read. */
  lastReadMessageId?: string;
  unreadCount: number;
  /** Owning group id for a channel scope; absent for DM scopes. */
  groupId?: string;
}

interface ReadMarkerState {
  /** scopeId (channelId or dmId) → read state. */
  scopes: Record<string, ScopeReadState>;
}

const [readState, setReadState] = createStore<ReadMarkerState>({ scopes: {} });

export { readState };

/**
 * scopeId → the message of the newest local mark still waiting for its PATCH
 * answer (see "Ordering" above). Not reactive: it only gates writes.
 */
const pendingMarks = new Map<string, string>();

/** Whether a provider report for `scopeId` naming `messageId` may be applied. */
function reportApplies(scopeId: string, messageId: string | undefined): boolean {
  const pending = pendingMarks.get(scopeId);
  return pending === undefined || pending === messageId;
}

/** The PATCH for `scopeId`'s mark of `messageId` was answered (or failed). */
function settlePendingMark(scopeId: string, messageId: string): void {
  if (pendingMarks.get(scopeId) === messageId) pendingMarks.delete(scopeId);
}

/** The store form of one provider-reported entry (`groupId` kept if omitted). */
function fromWire(e: ReadMarker, prev: ScopeReadState | undefined): ScopeReadState {
  const groupId = e.groupId ?? prev?.groupId;
  return {
    ...(e.lastReadMessageId !== undefined ? { lastReadMessageId: e.lastReadMessageId } : {}),
    unreadCount: e.unreadCount,
    ...(groupId !== undefined ? { groupId } : {}),
  };
}

/**
 * Replace the whole summary (hydrate). A scope with a pending local mark keeps
 * its local state unless the summary already names that mark (the summary may
 * have been read before the PATCH landed; its answer settles the scope).
 */
function setSummary(entries: ReadMarker[]): void {
  // A plain copy: `reconcile` must not be handed the store's own proxies.
  const local = (scopeId: string): ScopeReadState | undefined => {
    const s = readState.scopes[scopeId];
    return s && { ...s };
  };
  const next: Record<string, ScopeReadState> = {};
  for (const e of entries) {
    const kept = reportApplies(e.scopeId, e.lastReadMessageId) ? undefined : local(e.scopeId);
    next[e.scopeId] = kept
      ? { ...kept, ...(e.groupId !== undefined ? { groupId: e.groupId } : {}) }
      : fromWire(e, undefined);
  }
  for (const scopeId of pendingMarks.keys()) {
    const kept = next[scopeId] === undefined ? local(scopeId) : undefined;
    if (kept) next[scopeId] = kept;
  }
  // `reconcile` replaces the whole map (drops scopes absent from the new
  // summary); a bare object set would MERGE and leave stale keys behind.
  setReadState("scopes", reconcile(next));
}

/** GET the unread summary on session start and seed the store. */
export async function hydrateReadMarkers(): Promise<void> {
  const client = sessionClient();
  if (!client) return;
  try {
    const scopes = await getReadMarkers(client);
    setSummary(scopes);
  } catch {
    // Non-fatal: badges/divider degrade gracefully without the summary.
  }
}

/**
 * Mark `scopeId` read up to message `messageId` — the newest message the view
 * has shown. A no-op without an id or when the marker already names it.
 * Optimistically records the marker and zeros the unread count, then PATCHes
 * the provider (which tells every device through `read.updated`).
 *
 * Until the answer arrives the mark is pending, and provider reports that
 * would replace it are ignored (see "Ordering" above). The answer settles the
 * optimistic state: an advanced scope is applied unless a newer local mark has
 * replaced it meanwhile; a scope that did NOT advance means the provider holds
 * a newer marker already (or ignored the message), and a failed request leaves
 * the provider's state unknown, so in both cases the summary is re-read rather
 * than keeping a guess.
 */
export function markRead(scopeId: string, messageId: string | undefined): void {
  if (messageId === undefined) return;
  const cur = readState.scopes[scopeId];
  if (cur?.lastReadMessageId === messageId) return;

  setReadState("scopes", scopeId, (prev) => ({
    lastReadMessageId: messageId,
    unreadCount: 0,
    ...(prev?.groupId !== undefined ? { groupId: prev.groupId } : {}),
  }));

  const client = sessionClient();
  if (!client) return;
  pendingMarks.set(scopeId, messageId);
  void patchReadMarkers(client, [{ scopeId, lastReadMessageId: messageId }]).then(
    (scopes) => {
      settlePendingMark(scopeId, messageId);
      const entry = scopes.find((s) => s.scopeId === scopeId);
      if (!entry) {
        void hydrateReadMarkers();
        return;
      }
      if (readState.scopes[scopeId]?.lastReadMessageId === messageId) applyMarker(entry);
    },
    () => {
      settlePendingMark(scopeId, messageId);
      if (readState.scopes[scopeId]?.lastReadMessageId === messageId) void hydrateReadMarkers();
    },
  );
}

/** Store one provider-reported entry as the scope's state. */
function applyMarker(m: ReadMarker): void {
  setReadState("scopes", m.scopeId, (prev) => fromWire(m, prev));
}

/**
 * Fold provider-reported advances (`read.updated`) into the store. An entry is
 * ignored while a newer local mark for its scope is pending, unless it names
 * that mark (see "Ordering" above).
 */
export function applyReadUpdated(markers: ReadMarker[]): void {
  for (const m of markers) {
    if (reportApplies(m.scopeId, m.lastReadMessageId)) applyMarker(m);
  }
}

// --- Reactive getters -------------------------------------------------------

/** Unread count for a scope (channel or DM); 0 when unknown. */
export function unreadCountFor(scopeId: string): number {
  return readState.scopes[scopeId]?.unreadCount ?? 0;
}

/** The scope's read state for placing the "New messages" divider. */
export function readSnapshotFor(scopeId: string): ReadSnapshot {
  const s = readState.scopes[scopeId];
  return {
    ...(s?.lastReadMessageId !== undefined ? { lastReadMessageId: s.lastReadMessageId } : {}),
    unreadCount: s?.unreadCount ?? 0,
  };
}

/**
 * Total unread across ALL scopes (every channel + DM the user has a marker for).
 * Reactive — the basis for the out-of-app badges (tab title / favicon / PWA app
 * badge), summed with the unseen notification counts by the FX coordinator.
 */
export function totalUnread(): number {
  let total = 0;
  for (const s of Object.values(readState.scopes)) total += s.unreadCount;
  return total;
}

/**
 * Per-group unread rollup for the space rail: the sum of unread counts across the
 * group's channel scopes. Each channel scope carries its owning `groupId` (from
 * the unread summary / `read.updated` events), so this works for groups never
 * opened this session — it does NOT depend on `chat.channels` being populated.
 */
export function unreadForGroup(groupId: string): number {
  let total = 0;
  for (const s of Object.values(readState.scopes)) {
    if (s.groupId !== groupId) continue;
    total += s.unreadCount;
  }
  return total;
}

/** Clear all read state (logout). */
export function clearReadMarkers(): void {
  pendingMarks.clear();
  // `reconcile({})` truly empties the keyed map; a bare `{}` set would merge.
  setReadState("scopes", reconcile({}));
}

// --- WS wiring --------------------------------------------------------------

const installed = new WeakSet<OfscpWsClient>();

/**
 * Install the single `read.updated` → store listener on `ws` (idempotent), for
 * multi-device sync. Called once per connection by the auth controller on adopt,
 * BEFORE connecting, mirroring the presence listener.
 */
export function installReadMarkerListener(ws: OfscpWsClient): void {
  if (installed.has(ws)) return;
  installed.add(ws);
  ws.on("read.updated", (e) => {
    const data = (e as { data?: { markers?: ReadMarker[] } }).data;
    if (data?.markers && Array.isArray(data.markers)) applyReadUpdated(data.markers);
  });
  // Re-hydrate the summary after each (re)connect so a device that was offline
  // catches up on markers it missed (the event is fire-and-forget, not resumed).
  ws.onState((s) => {
    if (s === "connected") void hydrateReadMarkers();
  });
}
