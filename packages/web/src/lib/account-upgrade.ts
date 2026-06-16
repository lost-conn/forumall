import { persistUpgradedSession } from "./auth.ts";
/**
 * Guest account-upgrade flows (§4.8 — Forumall guest → full account).
 *
 * A provisional guest (no password, not federation-resolvable) can secure its
 * account two ways, both server-side endpoints that re-bind THIS device's key to
 * the new/target actor (the keyId is unchanged):
 *
 *   - **claim** (`POST /api/me/claim`): become a brand-new full account with a
 *     chosen handle + password. The guest identity is renamed across every table.
 *   - **merge** (`POST /api/me/merge`): fold into an EXISTING account by proving
 *     its handle + password. The guest's content moves into the target actor and
 *     the guest row is deleted.
 *
 * In BOTH cases the server keeps THIS device's keypair + keyId (it just rebinds
 * the key to the new/target actor), so the device stays logged in — only the
 * actor it signs as changes. The device private key lives in the IndexedDB
 * key-store keyed by `keyId` (NOT by actor/handle), so the rename leaves the key
 * completely untouched: no key migration is needed. We persist the upgraded
 * `StoredSession` and reload so the new actor is woven cleanly through the HTTP
 * client, the WS registry, and every store (the robust path for a deep identity
 * swap).
 */
import type { OfscpClient } from "./ofscp-client.ts";

/** Reserved prefix for provider-minted guest handles — a claim MUST NOT use it. */
export const GUEST_HANDLE_PREFIX = "guest_";

/**
 * Canonical handle format (mirrors the server's §4.1 `HandleSchema`): lowercase
 * alphanumeric plus `_`/`-`, 3–32 chars.
 */
const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;

export interface ClaimFormValues {
  handle: string;
  password: string;
  confirmPassword: string;
}

/**
 * Validate the **claim** form (new permanent account) client-side, mirroring the
 * server rules so the user gets immediate feedback before the round-trip:
 * handle format + non-reserved-prefix, password ≥ 8 chars, passwords match.
 * Returns `null` when valid, else the first user-facing error message.
 *
 * Pure (DOM-free) so it is unit-testable. The handle is lowercased/trimmed by the
 * caller before validation, matching AuthScreen.
 */
export function validateClaimForm(values: ClaimFormValues): string | null {
  const handle = values.handle.trim().toLowerCase();
  if (!handle) return "Choose a handle.";
  if (handle.startsWith(GUEST_HANDLE_PREFIX)) {
    return `Handle can't start with "${GUEST_HANDLE_PREFIX}".`;
  }
  if (!HANDLE_RE.test(handle)) {
    return "Handle must be 3–32 lowercase letters, numbers, '_' or '-'.";
  }
  if (values.password.length < 8) return "Password must be at least 8 characters.";
  if (values.password !== values.confirmPassword) return "Passwords don't match.";
  return null;
}

/** The shared claim/merge response shape: `{ actor, keyId, profile }`. */
export interface UpgradeResponse {
  actor: string;
  keyId: string;
  profile?: { handle?: string };
}

export interface ClaimInput {
  handle: string;
  password: string;
  displayName?: string;
}

/**
 * Claim a permanent account: the signed-in guest becomes a NEW full account with
 * the chosen handle + password. Returns the server's `{ actor, keyId, profile }`.
 */
export async function claimAccount(
  client: OfscpClient,
  input: ClaimInput,
): Promise<UpgradeResponse> {
  const res = await client.post<UpgradeResponse>("/api/me/claim", {
    handle: input.handle,
    password: input.password,
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });
  return res.data;
}

export interface MergeInput {
  handle: string;
  password: string;
}

/**
 * Merge into an existing account: the signed-in guest folds into the account
 * identified by `handle` + `password` (a login-equivalent credential check). The
 * guest identity goes away; this device is rebound to the target. Returns the
 * target's `{ actor, keyId, profile }`.
 */
export async function mergeIntoAccount(
  client: OfscpClient,
  input: MergeInput,
): Promise<UpgradeResponse> {
  const res = await client.post<UpgradeResponse>("/api/me/merge", {
    handle: input.handle,
    password: input.password,
  });
  return res.data;
}

/** Derive the local handle (without `@host`) from a canonical actor. */
function handleOf(actor: string, fallback?: string): string {
  if (fallback) return fallback;
  const at = actor.lastIndexOf("@");
  return at > 0 ? actor.slice(0, at) : actor;
}

/**
 * Apply an upgraded identity client-side after a successful claim/merge.
 *
 * Persists the new actor/handle into the stored session (keyId + host unchanged,
 * device key left in place — it is keyed by keyId, not actor) and then reloads
 * so the new actor is re-bootstrapped cleanly across the HTTP client, the WS
 * registry, and all stores. The reload is the correct, bulletproof path here: the
 * identity change is deep and threaded through many singletons.
 *
 * `reload` is injectable for tests; defaults to `location.reload()`.
 */
export function applyUpgradedIdentity(
  result: UpgradeResponse,
  opts: { reload?: () => void } = {},
): void {
  const handle = handleOf(result.actor, result.profile?.handle);
  persistUpgradedSession({ actor: result.actor, handle });
  const reload =
    opts.reload ??
    (() => {
      if (typeof location !== "undefined") location.reload();
    });
  reload();
}
