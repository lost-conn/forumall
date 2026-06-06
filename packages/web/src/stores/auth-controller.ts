/**
 * Auth controller (P8): the single orchestration point the UI calls. It runs the
 * register/login/restore/logout flows from `lib/auth.ts`, wires the resulting
 * authenticated `OfscpClient` and a live `OfscpWsClient` into the session store,
 * and reflects the WS connection lifecycle into the store for the status dot.
 *
 * The UI never talks to `lib/auth.ts` or the WS client directly — it calls these
 * functions, which keep the reactive session store and the live transport in
 * lock-step. The WS client gets its private seed straight from the key-store
 * (the same place the HTTP client's seed lives), so the seed is never threaded
 * through client internals.
 */
import {
  type AuthResult,
  type LoginInput,
  type RegisterInput,
  type StoredSession,
  login as authLogin,
  logout as authLogout,
  register as authRegister,
  restore as authRestore,
} from "../lib/auth.ts";
import type { KeyStore } from "../lib/key-store.ts";
import { keyStore as defaultKeyStore } from "../lib/key-store.ts";
import { OfscpWsClient } from "../lib/ofscp-ws.ts";
import { baseUrlForHost } from "../lib/provider.ts";
import {
  clearSession,
  sessionClient,
  setConnectionState,
  setSessionAuth,
  storedSession,
} from "./session.ts";

/**
 * Read the private seed for a session from the key-store (where the flow just
 * persisted it), then open + authenticate the home-provider WS and adopt the
 * whole authenticated session into the store.
 */
async function adopt(result: AuthResult, store: KeyStore): Promise<void> {
  const { session } = result;
  const privateKey = await store.getKey(session.keyId);
  if (!privateKey) throw new Error("device private key missing after auth flow");

  const base = baseUrlForHost(session.host);
  const ws = new OfscpWsClient({
    host: session.host,
    actor: session.actor,
    keyId: session.keyId,
    privateKey,
    url: `${base.replace(/^http/, "ws")}/api/ws`,
  });
  ws.onState(setConnectionState);
  // Fire-and-forget connect; the status dot reflects progress / retries.
  void ws.connect().catch(() => undefined);

  setSessionAuth({ client: result.client, stored: session, ws });
}

/** Register → keygen → device key → store → connect. Lands authenticated. */
export async function doRegister(input: RegisterInput): Promise<void> {
  const result = await authRegister(input);
  await adopt(result, input.keyStore ?? defaultKeyStore);
}

/** Login → keygen → device key → store → connect. Lands authenticated. */
export async function doLogin(input: LoginInput): Promise<void> {
  const result = await authLogin(input);
  await adopt(result, input.keyStore ?? defaultKeyStore);
}

/**
 * Restore on reload: rebuild the authenticated client from storage and reconnect
 * the WS, with no re-login. Returns true iff a session was restored.
 */
export async function doRestore(opts: { keyStore?: KeyStore } = {}): Promise<boolean> {
  const store = opts.keyStore ?? defaultKeyStore;
  const result = await authRestore({ keyStore: store });
  if (!result) return false;
  await adopt(result, store);
  return true;
}

/** Logout: revoke this device key server-side, wipe local key + session, close WS. */
export async function doLogout(opts: { keyStore?: KeyStore } = {}): Promise<boolean> {
  const store = opts.keyStore ?? defaultKeyStore;
  const client = sessionClient();
  const stored: StoredSession | null = storedSession();
  let revoked = false;
  if (client && stored) {
    revoked = await authLogout(client, stored, { keyStore: store });
  }
  // Tear down the live WS + reactive state.
  clearSession();
  return revoked;
}
