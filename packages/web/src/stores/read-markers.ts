/**
 * Read-marker store (read/unread tracking — a provider-local extension).
 *
 * Holds, per scope (`chn_…` channel id OR a `dmId`), the user's `lastReadSeq` and
 * the server-computed `unreadCount`. The store is the single source of truth for
 * unread badges (space rail, channel list, DM list) and the "New messages"
 * divider position.
 *
 *  - {@link hydrateReadMarkers} pulls the full summary on session start.
 *  - {@link markRead} optimistically advances a marker (monotonic: never
 *    decreases) + zeros its unread, then PATCHes the server.
 *  - {@link applyReadUpdated} folds an inbound `read.updated` WS event (another
 *    device advanced a marker) into the store.
 *  - {@link installReadMarkerListener} wires the single `read.updated` listener
 *    onto the home WS client (idempotent), mirroring the presence controller.
 *
 * ## Cursor → seq
 * Markers are keyed on the global monotonic `seq` (a number). Messages on the
 * client carry an OPAQUE cursor (`base64url(JSON.stringify({ seq }))`, the §7.2
 * encoding). {@link seqFromCursor} decodes a cursor to its `seq` so a caller can
 * advance a marker from the newest loaded message.
 */
import type { ReadMarker } from "@forumall/shared";
import { createStore } from "solid-js/store";
import type { OfscpWsClient } from "../lib/ofscp-ws.ts";
import { getReadMarkers, setReadMarkers as patchReadMarkers } from "../lib/read-markers-api.ts";
import { chat } from "./chat.ts";
import { sessionClient } from "./session.ts";

/** Per-scope read state. */
export interface ScopeReadState {
  lastReadSeq: number;
  unreadCount: number;
}

interface ReadMarkerState {
  /** scopeId (channelId or dmId) → read state. */
  scopes: Record<string, ScopeReadState>;
}

const [readState, setReadState] = createStore<ReadMarkerState>({ scopes: {} });

export { readState };

/**
 * Decode an opaque §7.2 message cursor to its `seq`, or `null` if it's malformed.
 * Mirrors the server `decodeMessageCursor` (base64url JSON `{ seq }`).
 */
export function seqFromCursor(cursor: string | undefined | null): number | null {
  if (!cursor) return null;
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function"
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, "base64").toString("utf8");
    const pos = JSON.parse(json) as { seq?: unknown };
    return typeof pos.seq === "number" ? pos.seq : null;
  } catch {
    return null;
  }
}

/** Replace the whole summary (hydrate). */
function setSummary(entries: ReadMarker[]): void {
  const next: Record<string, ScopeReadState> = {};
  for (const e of entries) {
    next[e.scopeId] = { lastReadSeq: e.lastReadSeq, unreadCount: e.unreadCount };
  }
  setReadState("scopes", next);
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
 * Advance the marker for `scopeId` up to `seq` (monotonic: a lower or equal seq is
 * a no-op). Optimistically zeros the scope's unread count, then PATCHes the server
 * (which re-broadcasts to other devices). Safe to call frequently — it short-
 * circuits when the marker would not move.
 */
export function markRead(scopeId: string, seq: number | null | undefined): void {
  if (seq == null || !Number.isFinite(seq)) return;
  const cur = readState.scopes[scopeId];
  if (cur && cur.lastReadSeq >= seq) return; // monotonic guard

  setReadState("scopes", scopeId, (prev) => ({
    lastReadSeq: Math.max(prev?.lastReadSeq ?? 0, seq),
    unreadCount: 0,
  }));

  const client = sessionClient();
  if (!client) return;
  void patchReadMarkers(client, [{ scopeId, lastReadSeq: seq }]).catch(() => undefined);
}

/** Fold an inbound `read.updated` event (multi-device sync) into the store. */
export function applyReadUpdated(markers: ReadMarker[]): void {
  for (const m of markers) {
    const cur = readState.scopes[m.scopeId];
    // Monotonic: only advance.
    if (cur && cur.lastReadSeq > m.lastReadSeq) continue;
    setReadState("scopes", m.scopeId, {
      lastReadSeq: Math.max(cur?.lastReadSeq ?? 0, m.lastReadSeq),
      unreadCount: m.unreadCount,
    });
  }
}

// --- Reactive getters -------------------------------------------------------

/** Unread count for a scope (channel or DM); 0 when unknown. */
export function unreadCountFor(scopeId: string): number {
  return readState.scopes[scopeId]?.unreadCount ?? 0;
}

/** The last-read `seq` for a scope; 0 when unknown. */
export function lastReadSeqFor(scopeId: string): number {
  return readState.scopes[scopeId]?.lastReadSeq ?? 0;
}

/**
 * Per-group unread rollup for the space rail: the sum of unread counts across the
 * group's known channels. Channels learn their `groupId` from the chat store, so
 * this stays in sync as channels are discovered.
 */
export function unreadForGroup(groupId: string): number {
  let total = 0;
  for (const ch of Object.values(chat.channels)) {
    if (ch.groupId !== groupId) continue;
    total += readState.scopes[ch.id]?.unreadCount ?? 0;
  }
  return total;
}

/** Clear all read state (logout). */
export function clearReadMarkers(): void {
  setReadState("scopes", {});
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
