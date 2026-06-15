/**
 * Admin-curated discover allowlist (Forumall extension, not OFSCP).
 *
 * The discovery feed (§11.2) is read-time-compiled from local
 * `tier='discoverable'` channels. This module narrows that feed to an admin
 * **allowlist of GROUPS**: only channels whose owning group has been explicitly
 * featured by a provider admin appear. With no featured groups the feed is empty
 * (`compileDiscoverPage` returns an empty page — not an error).
 *
 * Storage is the `discover_features` table (one row per featured group, UNIQUE
 * on `group_id` → idempotent feature). The HTTP admin surface
 * (`http/admin-discover.ts`) drives these helpers behind `requireAdmin`.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type DiscoverFeatureRow, discoverFeatures, groups } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";

/** `id` prefix for a feature row (`dsf_…`), matching the repo's id style. */
const FEATURE_ID_PREFIX = "dsf_";
/** Random bytes of entropy for a feature id (16 = 128 bits). */
const FEATURE_ID_BYTES = 16;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated feature id (`dsf_<base64url>`). */
function mintFeatureId(): string {
  const raw = new Uint8Array(FEATURE_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${FEATURE_ID_PREFIX}${toBase64Url(raw)}`;
}

/** The group ids currently featured in discover (insertion order). */
export function listFeaturedGroupIds(db: Db): string[] {
  return db.drizzle
    .select({ groupId: discoverFeatures.groupId })
    .from(discoverFeatures)
    .all()
    .map((r) => r.groupId);
}

/** Whether `groupId` is currently featured. */
export function isFeatured(db: Db, groupId: string): boolean {
  const row = db.drizzle
    .select({ id: discoverFeatures.id })
    .from(discoverFeatures)
    .where(eq(discoverFeatures.groupId, groupId))
    .limit(1)
    .all()[0];
  return row != null;
}

/**
 * Feature `groupId` (idempotent). Validates the group exists (else
 * `AppError.notFound`). If already featured, returns the existing row unchanged.
 * `addedBy` is the admin handle, recorded for audit.
 */
export function featureGroup(db: Db, groupId: string, addedBy: string): DiscoverFeatureRow {
  const group = db.drizzle
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)
    .all()[0];
  if (!group) {
    throw AppError.notFound({ detail: "no such group" });
  }

  const existing = db.drizzle
    .select()
    .from(discoverFeatures)
    .where(eq(discoverFeatures.groupId, groupId))
    .limit(1)
    .all()[0];
  if (existing) return existing;

  const row: DiscoverFeatureRow = {
    id: mintFeatureId(),
    groupId,
    addedBy,
    createdAt: Date.now(),
  };
  db.drizzle.insert(discoverFeatures).values(row).run();
  return row;
}

/** Unfeature `groupId` (idempotent — a no-op if it was not featured). */
export function unfeatureGroup(db: Db, groupId: string): void {
  db.drizzle.delete(discoverFeatures).where(eq(discoverFeatures.groupId, groupId)).run();
}
