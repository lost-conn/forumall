/**
 * Presence controller (P8, §7.5): the bridge between the live {@link OfscpWsClient}
 * and the reactive presence store.
 *
 * It does three things:
 *
 *  1. **Single inbound listener.** {@link installPresenceListener} registers ONE
 *     `presence.update` listener on a WS client and folds every event into the
 *     presence store (keyed by canonical actor). The auth controller installs it
 *     once per connection on adopt; reconnects re-emit fresh snapshots, which the
 *     listener overwrites in place. Idempotent per client.
 *
 *  2. **Reference-counted subscriptions.** Views (member lists, contacts, the open
 *     DM) call {@link subscribePresence} for the actors they render and the
 *     returned disposer on cleanup. Subscriptions are ref-counted across views so
 *     two views watching the same actor don't fight over the WS subscription: the
 *     server `presence.subscribe`/`presence.unsubscribe` is only sent when a
 *     subject's count crosses 0↔1. On `presence.subscribe` the server immediately
 *     sends a filtered snapshot, so a freshly-rendered dot lights up without a
 *     poll.
 *
 *  3. **Self presence.** {@link setMyPresence} issues the WS `presence.set` (the
 *     server treats it as `PUT /api/me/presence`) and optimistically reflects the
 *     caller's own availability/status into the store + the self-presence signal.
 *
 * Transport-only: the UI calls these and reads the store; it never touches the WS
 * client directly. The actor's OWN presence is never subscribed (the server
 * doesn't fan a subject their own update over a subscription) — the self signal
 * is the source of truth for the caller's own dot.
 */
import { rfc3339Timestamp } from "@forumall/shared";
import type { OfscpWsClient } from "../lib/ofscp-ws.ts";
import type { SettableAvailability } from "../lib/social-api.ts";
import {
  type Availability,
  type PresenceState,
  setMyPresenceState,
  setPresenceFor,
} from "./presence.ts";

/** A single WS command frame id counter (per session). */
let frameSeq = 0;
function frameId(prefix: string): string {
  frameSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${frameSeq.toString(36)}`;
}

/** Send a raw WS command frame through the client's underlying socket. */
function rawSend(ws: OfscpWsClient, type: string, data: Record<string, unknown>): void {
  (ws as unknown as { sendRaw(frame: Record<string, unknown>): void }).sendRaw({
    id: frameId(type.replace(/\W/g, "")),
    type,
    ts: rfc3339Timestamp(),
    data,
  });
}

/**
 * Send a command once the WS is connected. The WS client only auto-resumes
 * CHANNEL subscriptions across (re)connects, not presence ones, and `sendRaw`
 * silently drops a frame on a not-yet-OPEN socket. So a presence command issued
 * while the connection is still `connecting`/`reconnecting` would be lost. This
 * sends immediately when `connected`, otherwise defers to the next `connected`
 * state transition (one-shot).
 */
function sendWhenConnected(ws: OfscpWsClient, type: string, data: Record<string, unknown>): void {
  if (ws.state === "connected") {
    rawSend(ws, type, data);
    return;
  }
  const off = ws.onState((s) => {
    if (s === "connected") {
      off();
      rawSend(ws, type, data);
    }
  });
}

/** Shape of the inbound `presence.update` event `data`. */
interface PresenceUpdateData {
  user: string;
  presence: {
    availability?: Availability;
    status?: string;
    lastSeen?: string;
  };
}

/**
 * Ref-counted subscription registry, keyed by canonical actor. Module-level so it
 * survives component churn; cleared on logout via {@link resetPresenceSubscriptions}.
 */
const refCounts = new Map<string, number>();

/** The WS clients that already have the inbound listener installed (idempotency). */
const installed = new WeakSet<OfscpWsClient>();

/**
 * Install the single `presence.update` → store listener on `ws` (idempotent), and
 * a state listener that RE-SUBSCRIBES every active subject on each (re)connect.
 * The WS client only auto-resumes channel subscriptions, so presence ones must be
 * re-issued here; this also refreshes every snapshot after a reconnect. Called
 * once per connection by the auth controller on adopt.
 */
export function installPresenceListener(ws: OfscpWsClient): void {
  if (installed.has(ws)) return;
  installed.add(ws);
  ws.on("presence.update", (e) => {
    const data = (e as { data?: PresenceUpdateData }).data;
    if (!data?.user) return;
    const p = data.presence ?? {};
    const state: PresenceState = {
      availability: p.availability ?? "offline",
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...(p.lastSeen !== undefined ? { lastSeen: p.lastSeen } : {}),
    };
    setPresenceFor(data.user, state);
  });
  ws.onState((s) => {
    if (s !== "connected") return;
    const subjects = [...refCounts.keys()];
    if (subjects.length > 0) rawSend(ws, "presence.subscribe", { users: subjects });
  });
}

/**
 * Subscribe to live presence for `actors` over `ws`, ref-counted. Returns a
 * disposer that releases this caller's hold; the server-side subscription is only
 * issued when a subject's count goes 0→1 and dropped when it returns to 0. The
 * caller's own actor is filtered out (self presence is the self signal's job).
 */
export function subscribePresence(
  ws: OfscpWsClient | null,
  actors: string[],
  self?: string | null,
): () => void {
  if (!ws) return () => undefined;
  const subjects = [...new Set(actors)].filter((a) => a && a !== self);
  const fresh: string[] = [];
  for (const a of subjects) {
    const prev = refCounts.get(a) ?? 0;
    refCounts.set(a, prev + 1);
    if (prev === 0) fresh.push(a);
  }
  if (fresh.length > 0) {
    sendWhenConnected(ws, "presence.subscribe", { users: fresh });
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const stale: string[] = [];
    for (const a of subjects) {
      const prev = refCounts.get(a) ?? 0;
      const next = Math.max(0, prev - 1);
      if (next === 0) {
        refCounts.delete(a);
        stale.push(a);
      } else {
        refCounts.set(a, next);
      }
    }
    if (stale.length > 0 && ws.state === "connected") {
      rawSend(ws, "presence.unsubscribe", { users: stale });
    }
  };
}

/** Drop all ref-counts (logout / WS teardown). */
export function resetPresenceSubscriptions(): void {
  refCounts.clear();
}

/**
 * Re-issue `presence.subscribe` for `actors` WITHOUT changing ref-counts, to pull
 * a fresh filtered snapshot. A subject's snapshot is computed at subscribe time
 * against the (subject, viewer) relationship; when that relationship changes —
 * e.g. a contact request is accepted, crossing the `contacts` tier — the existing
 * subscription does NOT re-fan on its own (the subject's presence didn't change).
 * The contacts UI calls this after such a mutation so the viewer's dot reflects
 * the new tier promptly. (Server-side re-fan on relationship change would remove
 * the need for this; see the report.)
 */
export function refreshPresenceSnapshots(
  ws: OfscpWsClient | null,
  actors: string[],
  self?: string | null,
): void {
  if (!ws) return;
  const subjects = [...new Set(actors)].filter((a) => a && a !== self);
  if (subjects.length > 0) sendWhenConnected(ws, "presence.subscribe", { users: subjects });
}

/**
 * Set the caller's own availability + status via the WS `presence.set` (= the
 * `PUT /api/me/presence` semantics). Reflects it optimistically into the self
 * signal so the control updates instantly; the server fans the filtered update to
 * other viewers.
 */
export function setMyPresence(
  ws: OfscpWsClient | null,
  availability: SettableAvailability,
  status?: string,
): void {
  setMyPresenceState({
    availability,
    ...(status !== undefined && status !== "" ? { status } : {}),
  });
  if (!ws) return;
  sendWhenConnected(ws, "presence.set", {
    availability,
    ...(status !== undefined && status !== "" ? { status } : {}),
  });
}
