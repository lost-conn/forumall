/**
 * Presence store (P8, §7.5). Tracks per-actor availability the presence card +
 * member lists render. The WS client feeds it via `on("presence.update", …)`.
 */
import { createStore } from "solid-js/store";

export type Availability = "online" | "away" | "dnd" | "offline";

export interface PresenceState {
  availability: Availability;
  status?: string;
  lastSeen?: string;
}

interface PresenceStore {
  /** Presence by canonical actor (`handle@host`). */
  byActor: Record<string, PresenceState>;
}

const [presence, setPresence] = createStore<PresenceStore>({ byActor: {} });

export { presence };

export function setPresenceFor(actor: string, state: PresenceState): void {
  setPresence("byActor", actor, state);
}

export function presenceFor(actor: string): PresenceState {
  return presence.byActor[actor] ?? { availability: "offline" };
}

export function clearPresence(): void {
  setPresence({ byActor: {} });
}
