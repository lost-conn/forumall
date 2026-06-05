/**
 * Guest accounts + the reusable `UserProfile` builder (spec §4.8).
 *
 * A guest account is a lightweight, **provider-local** account created by
 * redeeming an invite (§5.6) instead of by password registration. It lives in
 * the existing `users` table with `guest = 1`, no `password_hash`, and an
 * optional `expires_at` carried from the invite. It authenticates exactly like a
 * normal account once provisioned: its first Ed25519 device key is registered
 * during provisioning and all subsequent requests are signed (§4.4).
 *
 * Guests are **not federated** (§4.8): the actor's domain is always this
 * provider's host, and remote providers MAY refuse to resolve/accept guest
 * actors (cross-provider rejection is largely P7). The provider still serves the
 * guest's public key at the §4.6 keys endpoint so local verification works,
 * which falls out for free because guest keys live in the same `device_keys`
 * table resolved by {@link resolveActorKeys}.
 */
import { type UserProfile, UserProfileSchema, rfc3339Timestamp } from "@forumall/shared";
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type UserRow, users } from "../db/schema.ts";

/** `handle` prefix for a minted guest account (`guest_<short>`). */
const GUEST_HANDLE_PREFIX = "guest_";
/** Random bytes of entropy for the guest handle suffix (4 bytes → 8 hex chars). */
const GUEST_HANDLE_BYTES = 4;

/** Mint a short, unique-ish guest handle (`guest_<hex>`). */
function mintGuestHandle(): string {
  const raw = new Uint8Array(GUEST_HANDLE_BYTES);
  crypto.getRandomValues(raw);
  return `${GUEST_HANDLE_PREFIX}${Buffer.from(raw).toString("hex")}`;
}

/** The raw user row for `handle`, or `null` if there is none. */
export function getUserRow(db: Db, handle: string): UserRow | null {
  return db.drizzle.select().from(users).where(eq(users.handle, handle)).limit(1).all()[0] ?? null;
}

/**
 * Build the canonical, schema-valid `UserProfile` for a local `handle` (§4.8,
 * §6). Minimal by design — the **P6 profile card extends this** (avatar, bio,
 * richer metadata, visibility). Returns `null` if no such user exists.
 *
 * The profile `id` is the user's canonical HTTPS URI
 * (`https://{domain}/api/users/{handle}`); `domain` is this provider's host.
 * `guest` and `expiresAt` are surfaced only when set, so a full account's
 * profile omits them.
 *
 * @param domain This provider's host (canonicalized, e.g. `a.com`).
 */
export function buildUserProfile(db: Db, domain: string, handle: string): UserProfile | null {
  const row = getUserRow(db, handle);
  if (!row) return null;
  return UserProfileSchema.parse({
    id: `https://${domain}/api/users/${handle}`,
    handle,
    domain,
    ...(row.displayName != null ? { displayName: row.displayName } : {}),
    ...(row.guest ? { guest: true } : {}),
    ...(row.expiresAt != null ? { expiresAt: rfc3339Timestamp(new Date(row.expiresAt)) } : {}),
    updatedAt: rfc3339Timestamp(new Date(row.createdAt)),
    metadata: [],
  });
}

/** Input to {@link createGuestUser}. */
export interface CreateGuestInput {
  /** Optional human display name supplied at provisioning. */
  readonly displayName?: string | undefined;
  /** Optional expiry (epoch millis) carried from the invite. */
  readonly expiresAt?: number | undefined;
}

/**
 * Create a provider-local guest account with a freshly minted `guest_<hex>`
 * handle, retrying on the (vanishingly unlikely) handle collision. The account
 * has `guest = 1` and no password. Returns the stored row.
 */
export function createGuestUser(db: Db, input: CreateGuestInput): UserRow {
  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = mintGuestHandle();
    if (getUserRow(db, handle)) continue;
    const row: UserRow = {
      handle,
      passwordHash: null,
      recoveryEmail: null,
      guest: true,
      displayName: input.displayName ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: Date.now(),
    };
    try {
      db.drizzle.insert(users).values(row).run();
      return row;
    } catch {
      // Lost a race on the handle PK — retry with a fresh handle.
    }
  }
  throw new Error("failed to mint a unique guest handle after several attempts");
}
