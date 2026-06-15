/**
 * Group-creation policy — who on this instance may create groups (Forumall
 * extension, not part of OFSCP).
 *
 * The provider admin (see `provider/admin.ts`) governs group creation with a
 * single policy:
 *  - `open`      — any authenticated user may create a group (the DEFAULT, and
 *                  the historical behavior).
 *  - `admin-only`— only the provider admin may create groups.
 *
 * Storage is the `app_meta` key/value table — no dedicated table / migration is
 * needed (mirrors `provider/branding.ts`). An absent row means "unset", which
 * resolves to the `open` default. The policy is surfaced (read-only) on the
 * public `GET /api/provider` so the web client can decide whether to show its
 * "Create group" entrypoint; it's toggled via the admin-only
 * `PUT /api/admin/group-policy`. Enforcement lives in `POST /api/groups`.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { appMeta } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";

/** Who may create groups on this instance. */
export type GroupCreationPolicy = "open" | "admin-only";

/** The accepted policy values; the source of truth for validation. */
export const GROUP_CREATION_POLICIES: readonly GroupCreationPolicy[] = ["open", "admin-only"];

/** The default policy when unset — open to any authenticated user. */
export const DEFAULT_GROUP_CREATION_POLICY: GroupCreationPolicy = "open";

/** `app_meta` key backing the policy. */
const KEY_POLICY = "groups.creationPolicy";

/** Read a single `app_meta` value, or `undefined` when the row is absent. */
function readMeta(db: Db, key: string): string | undefined {
  const row = db.drizzle
    .select({ value: appMeta.value })
    .from(appMeta)
    .where(eq(appMeta.key, key))
    .limit(1)
    .all()[0];
  return row?.value;
}

/** Upsert a single `app_meta` row (insert or overwrite the value + updatedAt). */
function writeMeta(db: Db, key: string, value: string): void {
  db.drizzle
    .insert(appMeta)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: Date.now() } })
    .run();
}

/**
 * The current group-creation policy. Falls back to {@link DEFAULT_GROUP_CREATION_POLICY}
 * (`open`) when unset or holding an unrecognized value (forward-compat).
 */
export function getGroupCreationPolicy(db: Db): GroupCreationPolicy {
  const raw = readMeta(db, KEY_POLICY);
  return GROUP_CREATION_POLICIES.includes(raw as GroupCreationPolicy)
    ? (raw as GroupCreationPolicy)
    : DEFAULT_GROUP_CREATION_POLICY;
}

/**
 * Set the group-creation policy (admin-only at the HTTP layer). Validates the
 * value ∈ {@link GROUP_CREATION_POLICIES}, else throws {@link AppError.badRequest}.
 * Returns the stored policy.
 */
export function setGroupCreationPolicy(db: Db, policy: string): GroupCreationPolicy {
  if (!GROUP_CREATION_POLICIES.includes(policy as GroupCreationPolicy)) {
    throw AppError.badRequest({
      detail: `policy must be one of: ${GROUP_CREATION_POLICIES.join(", ")}`,
    });
  }
  writeMeta(db, KEY_POLICY, policy);
  return policy as GroupCreationPolicy;
}
