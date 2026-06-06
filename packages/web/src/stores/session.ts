/**
 * Session store (P8): the authenticated identity, the live signing client + WS
 * connection, and the home provider's connection state. The auth controller
 * populates it on connect/register/login/restore and clears it on logout; the
 * rest of the app reads `actor`/`keyId` (and `client`) to build signed requests
 * and WS subscriptions.
 */
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { StoredSession } from "../lib/auth.ts";
import type { OfscpClient } from "../lib/ofscp-client.ts";
import type { OfscpWsClient, WsConnectionState } from "../lib/ofscp-ws.ts";
import type { ProviderInfo } from "../lib/provider.ts";

export interface SessionState {
  /** Authenticated actor `handle@host`, or null when logged out. */
  actor: string | null;
  /** Home provider host (signing authority), e.g. `providera.com`. */
  host: string | null;
  /** Active device key id. */
  keyId: string | null;
  /** Friendly name for this device's key. */
  deviceName: string | null;
  /** Live home-provider WS connection state. */
  connection: WsConnectionState;
}

const [session, setSession] = createStore<SessionState>({
  actor: null,
  host: null,
  keyId: null,
  deviceName: null,
  connection: "idle",
});

export { session };

/**
 * Live handles that aren't reactive store fields (the client/WS instances and
 * the full stored-session descriptor). Kept out of the reactive store so Solid
 * doesn't try to deep-proxy them; read via the accessors.
 */
let activeClient: OfscpClient | null = null;
let activeWs: OfscpWsClient | null = null;
let activeStored: StoredSession | null = null;

/** The current signing-capable client, or null when logged out. */
export function sessionClient(): OfscpClient | null {
  return activeClient;
}

/** The current home-provider WS client, or null. */
export function sessionWs(): OfscpWsClient | null {
  return activeWs;
}

/** The full stored-session descriptor (actor/host/keyId/handle/deviceName). */
export function storedSession(): StoredSession | null {
  return activeStored;
}

/** Adopt an authenticated session (after connect+register/login or restore). */
export function setSessionAuth(args: {
  client: OfscpClient;
  stored: StoredSession;
  ws?: OfscpWsClient;
}): void {
  activeClient = args.client;
  activeStored = args.stored;
  if (args.ws) activeWs = args.ws;
  setSession({
    actor: args.stored.actor,
    host: args.stored.host,
    keyId: args.stored.keyId,
    deviceName: args.stored.deviceName,
  });
}

/** Attach the live WS client (once connected). */
export function setSessionWs(ws: OfscpWsClient | null): void {
  activeWs = ws;
}

/** Update the home-connection lifecycle state (for a status indicator). */
export function setConnectionState(connection: WsConnectionState): void {
  setSession("connection", connection);
}

/** Clear the session (logout): closes the live WS and resets reactive state. */
export function clearSession(): void {
  activeWs?.close();
  activeClient = null;
  activeWs = null;
  activeStored = null;
  setSession({ actor: null, host: null, keyId: null, deviceName: null, connection: "idle" });
}

export function isAuthenticated(): boolean {
  return session.actor != null && session.keyId != null;
}

// --- Provider connection (first-run "connect to your provider", §3.1) -------

const [provider, setProvider] = createSignal<ProviderInfo | null>(null);
export { provider, setProvider };

/** Bootstrap-token holder during the register/login → device-key flow. */
const [bootstrapToken, setBootstrapToken] = createSignal<string | null>(null);
export { bootstrapToken, setBootstrapToken };
