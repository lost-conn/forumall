/**
 * Web Push key + subscription store (provider-LOCAL extension — not in the OFSCP
 * v0.1 object model). Two concerns:
 *
 *  1. **VAPID key** — {@link getVapidKey} generates the provider's P-256 push
 *     identity once and persists it (mirroring `provider/signing-key.ts`); the
 *     public half is the `applicationServerKey` browsers subscribe with, the
 *     private scalar signs each per-request VAPID JWT.
 *  2. **Subscriptions** — {@link addSubscription} / {@link listSubscriptions} /
 *     {@link removeSubscription} / {@link deleteSubscriptionByEndpoint} /
 *     {@link markDelivered} own the `push_subscriptions` row lifecycle. A
 *     subscription binds a LOCAL `recipient` (handle) to a browser
 *     `PushSubscription` ({endpoint, p256dh, auth}).
 *
 * Delivery itself lives in `provider/push-send.ts` (fire-and-forget) so the HTTP
 * layer can register/unregister without pulling in the crypto/fetch path.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import {
  type PushKeyRow,
  type PushSubscriptionRow,
  pushKeys,
  pushSubscriptions,
} from "../db/schema.ts";
import { type VapidKeys, generateVapidKeys } from "../lib/web-push.ts";

/** `psh_` id prefix + entropy for a push subscription. */
const SUBSCRIPTION_ID_PREFIX = "psh_";
const SUBSCRIPTION_ID_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Mint a provider-generated subscription id (`psh_<base64url>`). */
function mintSubscriptionId(): string {
  const raw = new Uint8Array(SUBSCRIPTION_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${SUBSCRIPTION_ID_PREFIX}${toBase64Url(raw)}`;
}

/** Mint a stable VAPID key id (`vpk-<short hex>`). */
function mintVapidKeyId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `vpk-${hex}`;
}

// ---------------------------------------------------------------------------
// VAPID key (generate-once, restart-safe — mirrors getProviderSigningKey)
// ---------------------------------------------------------------------------

/** The provider's VAPID key for signing pushes + publishing the public key. */
export interface StoredVapidKey extends VapidKeys {
  readonly keyId: string;
  readonly algorithm: string;
  readonly createdAt: number;
}

function toStoredKey(row: PushKeyRow): StoredVapidKey {
  return {
    keyId: row.keyId,
    publicKey: row.publicKey,
    privateKey: row.privateKey,
    algorithm: row.algorithm,
    createdAt: row.createdAt,
  };
}

/**
 * Return the provider's VAPID key, generating + persisting it on first call.
 * Idempotent and restart-safe: once a row exists it is reused verbatim, so the
 * public key (which browsers subscribed against) is stable across restarts.
 */
export function getVapidKey(db: Db): StoredVapidKey {
  const existing = db.drizzle.select().from(pushKeys).orderBy(pushKeys.createdAt).limit(1).all();
  if (existing.length > 0 && existing[0]) return toStoredKey(existing[0]);

  const { publicKey, privateKey } = generateVapidKeys();
  const row: PushKeyRow = {
    keyId: mintVapidKeyId(),
    publicKey,
    privateKey,
    algorithm: "P-256",
    createdAt: Date.now(),
  };
  db.drizzle.insert(pushKeys).values(row).onConflictDoNothing().run();

  // Re-read so a race between two boots converges on a single key.
  const persisted = db.drizzle.select().from(pushKeys).orderBy(pushKeys.createdAt).limit(1).all();
  const winner = persisted[0];
  if (!winner) throw new Error("VAPID push key could not be persisted");
  return toStoredKey(winner);
}

// ---------------------------------------------------------------------------
// Subscription CRUD
// ---------------------------------------------------------------------------

/** A browser PushSubscription as posted by the client. */
export interface SubscriptionInput {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/**
 * Upsert a subscription for `recipient`, keyed on the unique `endpoint`. A
 * re-subscribe (same endpoint, e.g. after the browser refreshed its keys or the
 * user re-enabled on another account) updates the keys + recipient in place and
 * keeps the same row. Returns the row's id.
 */
export function addSubscription(db: Db, recipient: string, sub: SubscriptionInput): string {
  const existing = db.drizzle
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, sub.endpoint))
    .limit(1)
    .all()[0];

  if (existing) {
    db.drizzle
      .update(pushSubscriptions)
      .set({ recipient, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
      .where(eq(pushSubscriptions.endpoint, sub.endpoint))
      .run();
    return existing.id;
  }

  const row: PushSubscriptionRow = {
    id: mintSubscriptionId(),
    recipient,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    createdAt: Date.now(),
    lastDeliveredAt: null,
  };
  db.drizzle.insert(pushSubscriptions).values(row).run();
  return row.id;
}

/** All subscriptions for a LOCAL recipient (oldest-first). */
export function listSubscriptions(db: Db, recipient: string): PushSubscriptionRow[] {
  return db.drizzle
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.recipient, recipient))
    .orderBy(pushSubscriptions.createdAt)
    .all();
}

/**
 * Remove a subscription owned by `recipient`, addressed either by its `endpoint`
 * or its `psh_…` id. Returns true iff a matching row owned by `recipient` was
 * deleted. A caller can only remove their own subscriptions.
 */
export function removeSubscription(db: Db, recipient: string, endpointOrId: string): boolean {
  const match = db.drizzle
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.recipient, recipient))
    .all()
    .find((r) => r.endpoint === endpointOrId || r.id === endpointOrId);
  if (!match) return false;
  db.drizzle.delete(pushSubscriptions).where(eq(pushSubscriptions.id, match.id)).run();
  return true;
}

/**
 * Delete a subscription by its endpoint regardless of owner — the 410/404 dead-
 * subscription cleanup path (a push service reported the endpoint gone). Returns
 * true iff a row was deleted.
 */
export function deleteSubscriptionByEndpoint(db: Db, endpoint: string): boolean {
  const res = db.drizzle
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run();
  return ((res as unknown as { changes?: number }).changes ?? 0) > 0;
}

/** Stamp `lastDeliveredAt = now` on a subscription after a successful push. */
export function markDelivered(db: Db, id: string): void {
  db.drizzle
    .update(pushSubscriptions)
    .set({ lastDeliveredAt: Date.now() })
    .where(eq(pushSubscriptions.id, id))
    .run();
}
