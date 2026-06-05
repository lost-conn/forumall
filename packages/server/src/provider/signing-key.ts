/**
 * The provider's own Ed25519 signing identity (spec §8.1).
 *
 * Distinct from user device keys: this key signs *provider-to-provider*
 * requests where the provider itself is the actor (e.g. notification webhook
 * delivery, §10). It is generated once on first boot, persisted in the
 * `provider_keys` table, and reused across restarts (a second boot MUST NOT
 * regenerate it).
 *
 * The public half is published in the discovery document under
 * `provider.publicKeys` (§3.1). The private seed is internal-only and MUST
 * never appear in any HTTP response.
 *
 * P7 (provider-signed requests) signs with this key via {@link getProviderSigningKey}.
 */
import { generateKeyPair } from "@forumall/shared";
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type ProviderKeyRow, providerKeys } from "../db/schema.ts";

/** The provider's signing key as needed to sign or to publish in discovery. */
export interface ProviderSigningKey {
  /** Stable `key_id`, e.g. `psk-3f9a2c`. Published in discovery. */
  readonly keyId: string;
  /** Base64 raw 32-byte Ed25519 public key. Published in discovery. */
  readonly publicKey: string;
  /** Base64 raw 32-byte Ed25519 private seed. Secret — never serialize to HTTP. */
  readonly privateKey: string;
  /** Always `"Ed25519"` in v0.1. */
  readonly algorithm: string;
  /** Creation time (epoch millis). Rendered as RFC 3339 `created_at`. */
  readonly createdAt: number;
}

/** Mint a stable, human-recognizable provider key id (`psk-<short hex>`). */
function mintKeyId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `psk-${hex}`;
}

function toSigningKey(row: ProviderKeyRow): ProviderSigningKey {
  return {
    keyId: row.keyId,
    publicKey: row.publicKey,
    privateKey: row.privateKey,
    algorithm: row.algorithm,
    createdAt: row.createdAt,
  };
}

/**
 * Return the provider's signing key, generating + persisting it on first call.
 *
 * Idempotent and restart-safe: once a row exists it is reused verbatim, so the
 * `key_id` and `public_key` are stable across process restarts. If multiple
 * keys ever exist (rotation), the oldest is treated as the active signing key.
 *
 * The returned object includes the private key for internal signing use; do
 * NOT pass it directly into an HTTP response.
 */
export function getProviderSigningKey(db: Db): ProviderSigningKey {
  const existing = db.drizzle
    .select()
    .from(providerKeys)
    .orderBy(providerKeys.createdAt)
    .limit(1)
    .all();

  if (existing.length > 0 && existing[0]) {
    return toSigningKey(existing[0]);
  }

  // First boot: generate and persist. Use INSERT OR IGNORE semantics via a
  // re-read so a race between two boots converges on a single key.
  const { publicKey, privateKey } = generateKeyPair();
  const row: ProviderKeyRow = {
    keyId: mintKeyId(),
    publicKey,
    privateKey,
    algorithm: "Ed25519",
    createdAt: Date.now(),
  };
  db.drizzle.insert(providerKeys).values(row).onConflictDoNothing().run();

  // Re-read to get whichever row won (covers the concurrent-insert case).
  const persisted = db.drizzle
    .select()
    .from(providerKeys)
    .orderBy(providerKeys.createdAt)
    .limit(1)
    .all();
  const winner = persisted[0];
  if (!winner) {
    // Should be unreachable: we just inserted. Guard for the type checker.
    throw new Error("provider signing key could not be persisted");
  }
  return toSigningKey(winner);
}

/** A public-only view of a provider signing key, safe to publish in discovery. */
export interface PublicProviderKey {
  readonly keyId: string;
  readonly publicKey: string;
  readonly algorithm: string;
  readonly createdAt: number;
}

/** Strip the private seed; only public material may be served (§3.1). */
export function toPublicKey(key: ProviderSigningKey): PublicProviderKey {
  return {
    keyId: key.keyId,
    publicKey: key.publicKey,
    algorithm: key.algorithm,
    createdAt: key.createdAt,
  };
}

/** Look up a provider signing key by `key_id` (for future rotation/verify use). */
export function getProviderSigningKeyById(db: Db, keyId: string): ProviderSigningKey | null {
  const row = db.drizzle
    .select()
    .from(providerKeys)
    .where(eq(providerKeys.keyId, keyId))
    .limit(1)
    .all();
  return row[0] ? toSigningKey(row[0]) : null;
}
