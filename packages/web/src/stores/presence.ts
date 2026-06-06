/**
 * Presence store (P8, §7.5). Tracks per-actor availability the presence card +
 * member lists render, plus the caller's OWN explicit presence (driven by the
 * self-presence control). The WS client feeds the per-actor map via
 * `on("presence.update", …)` (see `presence-controller.ts`); the self entry is
 * set locally on `presence.set` and never arrives back over a subscription.
 */
import { createStore } from "solid-js/store";

export type Availability = "online" | "away" | "dnd" | "offline";

export interface PresenceState {
  availability: Availability;
  status?: string;
  lastSeen?: string;
}

/** The caller's own settable presence (never `offline` while connected). */
export interface SelfPresenceState {
  availability: "online" | "away" | "dnd";
  status?: string;
}

interface PresenceStore {
  /** Presence by canonical actor (`handle@host`) — other users, from the server. */
  byActor: Record<string, PresenceState>;
  /** The caller's own explicit presence (drives the self-presence control). */
  self: SelfPresenceState;
}

const [presence, setPresence] = createStore<PresenceStore>({
  byActor: {},
  self: { availability: "online" },
});

export { presence };

export function setPresenceFor(actor: string, state: PresenceState): void {
  setPresence("byActor", actor, state);
}

export function presenceFor(actor: string): PresenceState {
  return presence.byActor[actor] ?? { availability: "offline" };
}

/** Update the caller's own explicit presence (optimistic, on `presence.set`). */
export function setMyPresenceState(state: SelfPresenceState): void {
  setPresence("self", state);
}

/** Reset everything (logout): clears the per-actor map and the self entry. */
export function clearPresence(): void {
  setPresence({ byActor: {}, self: { availability: "online" } });
}
