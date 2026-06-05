/**
 * Session store (P8): the authenticated identity + the home provider's
 * connection state. Minimal but real — the auth card populates it on login and
 * the rest of the app reads `actor`/`keyId` to build signed requests and WS
 * connections.
 */
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { WsConnectionState } from "../lib/ofscp-ws";

export interface SessionState {
  /** Authenticated actor `handle@host`, or null when logged out. */
  actor: string | null;
  /** Home provider host (signing authority), e.g. `providera.com`. */
  host: string | null;
  /** Active device key id. */
  keyId: string | null;
  /** Live home-provider WS connection state. */
  connection: WsConnectionState;
}

const [session, setSession] = createStore<SessionState>({
  actor: null,
  host: null,
  keyId: null,
  connection: "idle",
});

export { session };

/** Set the authenticated identity (after login + device-key registration). */
export function setIdentity(identity: { actor: string; host: string; keyId: string }): void {
  setSession({ ...identity });
}

/** Update the home-connection lifecycle state (for a status indicator). */
export function setConnectionState(connection: WsConnectionState): void {
  setSession("connection", connection);
}

/** Clear the session (logout). */
export function clearSession(): void {
  setSession({ actor: null, host: null, keyId: null, connection: "idle" });
}

export function isAuthenticated(): boolean {
  return session.actor != null && session.keyId != null;
}

/** Bootstrap-token holder during the register/login → device-key flow. */
const [bootstrapToken, setBootstrapToken] = createSignal<string | null>(null);
export { bootstrapToken, setBootstrapToken };
