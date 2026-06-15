/**
 * `/api/admin/group-policy` router — provider-admin control over who may create
 * groups (Forumall extension, not OFSCP). All routes are `requireSignature()` +
 * `requireAdmin()` (403 for non-admins).
 *
 *  - `PUT /api/admin/group-policy` — body `{ policy: 'open' | 'admin-only' }`.
 *    Validates + stores the policy (see `provider/group-policy.ts`) and returns
 *    `{ policy }`. An invalid value → 400.
 *
 * The policy itself is surfaced (read-only) on the PUBLIC `GET /api/provider`
 * (see `http/provider.ts`) so the web client can decide whether to show its
 * "Create group" entrypoint; enforcement happens in `POST /api/groups`.
 */
import { Hono } from "hono";

import { type GroupCreationPolicy, setGroupCreationPolicy } from "../provider/group-policy.ts";
import { requireAdmin } from "./admin-guard.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

export function createAdminSettingsRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  const admin = requireAdmin();

  /** PUT /api/admin/group-policy — set who may create groups. */
  router.put("/group-policy", signed, admin, async (c) => {
    const { db } = c.var;
    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be JSON" });
    });
    if (typeof raw !== "object" || raw === null) {
      throw AppError.badRequest({ detail: "request body must be a JSON object" });
    }
    const policy = (raw as Record<string, unknown>).policy;
    if (typeof policy !== "string") {
      throw AppError.badRequest({ detail: "policy must be a string" });
    }
    const stored: GroupCreationPolicy = setGroupCreationPolicy(db, policy);
    return c.json({ policy: stored });
  });

  return router;
}
