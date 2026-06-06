/**
 * Client auth flow (P8, spec §4.1–§4.3, §4.7).
 *
 * Glues the §4 primitives into the register/login/restore/logout flows the UI
 * drives. The shape of every flow is the same bootstrap → keygen → device-key →
 * store sequence:
 *
 *   1. register/login (handle + password) → a single-use **bootstrap token**
 *      (§4.1, §4.2). Unauthenticated.
 *   2. **generate a fresh Ed25519 keypair in-browser** (`generateKeyPair`). The
 *      private seed never leaves this device.
 *   3. `registerDeviceKey(bootstrapToken, { publicKey, deviceName })` (§4.3) →
 *      the server mints a `key_id` bound to the handle. Only the PUBLIC key is
 *      sent over the wire.
 *   4. persist the PRIVATE seed under that `key_id` in the IndexedDB key-store,
 *      and persist a small session descriptor (actor `handle@host`, keyId, host)
 *      in localStorage so a reload can restore the authenticated client without
 *      re-login.
 *
 * A login registers a FRESH device key for THIS device (each device holds its
 * own key, §4.3) — so "logging in on a new device" and "first registration" land
 * on the same store step.
 *
 * Restore (reload): read the stored session descriptor, look up the matching
 * private seed in the key-store, and rebuild an authenticated `OfscpClient` — no
 * password, no network round-trip needed to be "logged in".
 *
 * Logout (§4.7): revoke THIS device's key on the server (so its credential is
 * dead immediately), then wipe the private seed locally and clear the session.
 */
import { generateKeyPair, publicKeyFromPrivate } from "@forumall/shared";
import type { KeyStore } from "./key-store.ts";
import { keyStore as defaultKeyStore } from "./key-store.ts";
import { OfscpClient } from "./ofscp-client.ts";
import { baseUrlForHost } from "./provider.ts";

const SESSION_KEY = "forumall.session";

/** A restorable session descriptor (everything but the private seed). */
export interface StoredSession {
  /** Canonical actor `handle@host`. */
  actor: string;
  /** Logical provider host (signing authority). */
  host: string;
  /** This device's server-assigned key id. */
  keyId: string;
  /** Local handle (without the host). */
  handle: string;
  /** Friendly device label shown in the device-key list. */
  deviceName: string;
}

/** The result of a successful auth flow: a signing-capable client + session. */
export interface AuthResult {
  client: OfscpClient;
  session: StoredSession;
}

/** A sensible default device name derived from the browser/user-agent. */
export function defaultDeviceName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Mobile|Android|iPhone/i.test(ua)) return "Mobile browser";
  if (/Mac OS X/i.test(ua)) return "Browser on macOS";
  if (/Windows/i.test(ua)) return "Browser on Windows";
  if (/Linux/i.test(ua)) return "Browser on Linux";
  return "Web browser";
}

/** Persist the session descriptor (NOT the private key) so reload can restore. */
function storeSession(session: StoredSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* best-effort */
  }
}

/** Read the persisted session descriptor, if any. */
export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.actor || !parsed.host || !parsed.keyId || !parsed.handle) return null;
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

/** Wipe the persisted session descriptor. */
function dropSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * The shared bootstrap → keygen → device-key → store tail used by both register
 * and login. Given a bootstrap token (already obtained for `handle`), generate a
 * device key, register its public half, persist the private half + session, and
 * return an authenticated client.
 */
async function completeBootstrap(
  anonClient: OfscpClient,
  opts: {
    bootstrapToken: string;
    handle: string;
    host: string;
    deviceName: string;
    keyStore: KeyStore;
  },
): Promise<AuthResult> {
  // 2. Generate the device keypair in-browser. The private seed stays here.
  const { privateKey, publicKey: derivedPublic } = generateKeyPair();
  // Defensive: the wire public key is ALWAYS derived from the private seed, so a
  // bug can never accidentally upload private material as the "public" key.
  const publicKey = publicKeyFromPrivate(privateKey);
  if (publicKey !== derivedPublic) {
    throw new Error("internal: generated keypair is inconsistent");
  }

  // 3. Register only the PUBLIC key against the bootstrap token (§4.3).
  const { key_id: keyId } = await anonClient.registerDeviceKey(opts.bootstrapToken, {
    publicKey,
    deviceName: opts.deviceName,
  });

  // 4a. Persist the PRIVATE seed locally, keyed by the server key id.
  await opts.keyStore.setKey(keyId, privateKey);

  // 4b. Build the authenticated, signing-capable client.
  const actor = `${opts.handle}@${opts.host}`;
  const client = anonClient.withIdentity({ actor, keyId, privateKey });

  // 4c. Persist the restorable session descriptor.
  const session: StoredSession = {
    actor,
    host: opts.host,
    keyId,
    handle: opts.handle,
    deviceName: opts.deviceName,
  };
  storeSession(session);

  return { client, session };
}

/** Build an anonymous client for a host (used to register/login). */
function anonClientFor(host: string, fetchImpl?: typeof fetch): OfscpClient {
  return new OfscpClient({
    baseUrl: baseUrlForHost(host),
    authority: host,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

export interface RegisterInput {
  host: string;
  handle: string;
  password: string;
  recoveryEmail?: string;
  deviceName?: string;
  keyStore?: KeyStore;
  fetch?: typeof fetch;
}

/** Full register flow: account → bootstrap → device key → store (§4.1.1 → §4.3). */
export async function register(input: RegisterInput): Promise<AuthResult> {
  const anon = anonClientFor(input.host, input.fetch);
  const { bootstrap_token } = await anon.register({
    handle: input.handle,
    password: input.password,
    ...(input.recoveryEmail ? { recoveryEmail: input.recoveryEmail } : {}),
  });
  return completeBootstrap(anon, {
    bootstrapToken: bootstrap_token,
    handle: input.handle,
    host: input.host,
    deviceName: input.deviceName ?? defaultDeviceName(),
    keyStore: input.keyStore ?? defaultKeyStore,
  });
}

export interface LoginInput {
  host: string;
  handle: string;
  password: string;
  deviceName?: string;
  keyStore?: KeyStore;
  fetch?: typeof fetch;
}

/** Full login flow: a login registers a fresh device key for THIS device (§4.3). */
export async function login(input: LoginInput): Promise<AuthResult> {
  const anon = anonClientFor(input.host, input.fetch);
  const { bootstrap_token } = await anon.login({
    handle: input.handle,
    password: input.password,
  });
  return completeBootstrap(anon, {
    bootstrapToken: bootstrap_token,
    handle: input.handle,
    host: input.host,
    deviceName: input.deviceName ?? defaultDeviceName(),
    keyStore: input.keyStore ?? defaultKeyStore,
  });
}

export interface GuestRedeemInput {
  host: string;
  token: string;
  displayName?: string;
  deviceName?: string;
  keyStore?: KeyStore;
  fetch?: typeof fetch;
}

/** The guest-redeem response shape (§5.6/§4.8). */
interface GuestRedeemResponse {
  actor: string;
  key_id: string;
  profile?: { handle?: string };
  groupId: string;
  role?: string;
}

/** A guest redeem result: an authenticated session + the group it joined. */
export interface GuestRedeemResult extends AuthResult {
  groupId: string;
  role?: string;
}

/**
 * Guest redeem (§5.6/§4.8): for a user with NO account, redeeming a `grantsGuest`
 * invite provisions a provider-local guest account in-browser. We generate a
 * fresh Ed25519 keypair (the private seed never leaves the device), POST only its
 * PUBLIC half to the UNSIGNED `POST /api/invites/{token}/guest`, and the server
 * mints a guest handle + binds the device key. We then persist the private seed +
 * a restorable session exactly like register/login, so the guest lands
 * authenticated and signs subsequent requests itself.
 */
export async function redeemGuest(input: GuestRedeemInput): Promise<GuestRedeemResult> {
  const store = input.keyStore ?? defaultKeyStore;
  const anon = anonClientFor(input.host, input.fetch);
  const deviceName = input.deviceName ?? defaultDeviceName();

  // Generate the device keypair in-browser; the private seed stays here.
  const { privateKey } = generateKeyPair();
  const publicKey = publicKeyFromPrivate(privateKey);

  const res = await anon.post<GuestRedeemResponse>(
    `/api/invites/${input.token}/guest`,
    {
      public_key: publicKey,
      algorithm: "Ed25519",
      device_name: deviceName,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    },
    { anonymous: true },
  );
  const body = res.data;

  // The server returns the canonical actor (`guest…@host`). Derive the local
  // handle from it for the session descriptor.
  const at = body.actor.lastIndexOf("@");
  const handle = body.profile?.handle ?? (at > 0 ? body.actor.slice(0, at) : body.actor);

  // Persist the private seed under the server-assigned key id, build the signing
  // client, and persist a restorable session.
  await store.setKey(body.key_id, privateKey);
  const client = anon.withIdentity({ actor: body.actor, keyId: body.key_id, privateKey });
  const session: StoredSession = {
    actor: body.actor,
    host: input.host,
    keyId: body.key_id,
    handle,
    deviceName,
  };
  storeSession(session);

  return { client, session, groupId: body.groupId, ...(body.role ? { role: body.role } : {}) };
}

/**
 * Restore the authenticated client from a persisted session + the matching
 * private seed in the key-store. Returns the client, or `null` when there is no
 * complete stored session (logged out, or the private key is gone). No network.
 */
export async function restore(
  opts: { keyStore?: KeyStore; fetch?: typeof fetch } = {},
): Promise<AuthResult | null> {
  const session = loadSession();
  if (!session) return null;
  const store = opts.keyStore ?? defaultKeyStore;
  const privateKey = await store.getKey(session.keyId);
  if (!privateKey) {
    // The session descriptor outlived its key (shouldn't happen, but stay safe):
    // treat as logged out so the UI shows the auth screen.
    dropSession();
    return null;
  }
  const client = new OfscpClient({
    baseUrl: baseUrlForHost(session.host),
    authority: session.host,
    actor: session.actor,
    keyId: session.keyId,
    privateKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return { client, session };
}

/**
 * Logout (§4.7): revoke THIS device's key on the server, then wipe the local
 * private seed and the session descriptor. The server revoke is best-effort —
 * even if it fails (offline), the local credential is destroyed so the device
 * can no longer sign. Returns `true` iff the server-side revoke succeeded.
 */
export async function logout(
  client: OfscpClient,
  session: StoredSession,
  opts: { keyStore?: KeyStore } = {},
): Promise<boolean> {
  const store = opts.keyStore ?? defaultKeyStore;
  let revoked = false;
  try {
    if (client.canSign()) {
      const res = await client.delete(`/api/auth/device-keys/${session.keyId}`);
      revoked = res.status === 204;
    }
  } catch {
    revoked = false;
  } finally {
    await store.remove(session.keyId).catch(() => undefined);
    dropSession();
  }
  return revoked;
}
