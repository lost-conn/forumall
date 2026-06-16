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
  /**
   * Whether the current user is a provider administrator (Forumall extension).
   * Hydrated from `GET /api/me` after auth; false until known. Later admin UI
   * (branding / discover curation / group gate) gates on this.
   */
  isAdmin: boolean;
  /**
   * Whether the current user is a provisional GUEST account (no password, not
   * federation-resolvable). Hydrated from `GET /api/me` (`profile.guest`) after
   * auth; false until known. Gates the account-upgrade UI (claim / merge).
   */
  isGuest: boolean;
}

const [session, setSession] = createStore<SessionState>({
  actor: null,
  host: null,
  keyId: null,
  deviceName: null,
  connection: "idle",
  isAdmin: false,
  isGuest: false,
});

export { session };

/** Whether the current user is a provider administrator (Forumall extension). */
export function isAdmin(): boolean {
  return session.isAdmin;
}

/** Set the current user's provider-admin status (hydrated from `GET /api/me`). */
export function setIsAdmin(value: boolean): void {
  setSession("isAdmin", value);
}

/** Whether the current user is a provisional guest account (Forumall extension). */
export function isGuest(): boolean {
  return session.isGuest;
}

/** Set the current user's guest status (hydrated from `GET /api/me`). */
export function setIsGuest(value: boolean): void {
  setSession("isGuest", value);
}

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
    // isAdmin / isGuest are hydrated separately from GET /api/me; reset to a
    // known-false baseline here so a previous session's value can't leak through.
    isAdmin: false,
    isGuest: false,
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
  setSession({
    actor: null,
    host: null,
    keyId: null,
    deviceName: null,
    connection: "idle",
    isAdmin: false,
    isGuest: false,
  });
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
