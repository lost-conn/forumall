/**
 * `requireAdmin` — the provider-admin HTTP guard (Forumall extension, not OFSCP).
 *
 * MUST run **after** `requireSignature()` (it reads `c.var.actor`, which the
 * signature middleware sets). It throws `AppError.forbidden` unless the
 * authenticated caller is a provider admin per {@link isProviderAdmin}. Mount it
 * on admin-only routers, e.g.:
 *
 * ```ts
 * const router = new Hono<AppBindings>();
 * const signed = requireSignature();
 * router.get("/admin/thing", signed, requireAdmin(), (c) => { ... });
 * ```
 *
 * Consumed by the branding (`PUT /api/provider`), discover-curation
 * (`/api/admin/discover`) and group-policy (`/api/admin/group-policy`) routers.
 * Admin is a LOCAL identity — see the guard's own doc for why a remote actor is
 * rejected outright.
 */
import type { MiddlewareHandler } from "hono";

import { isProviderAdmin } from "../provider/admin.ts";
import { AppError } from "./errors.ts";
import { requireLocalHandle } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/**
 * Build the provider-admin authorization middleware (run after `requireSignature`).
 *
 * Admin is a **local** identity: `users.is_admin` / `config.adminHandles` are
 * handles in THIS provider's namespace. A remote actor (§4.6) authenticates just
 * as successfully as a local one, so the caller is first narrowed to a local
 * handle via {@link requireLocalHandle} (403 otherwise) — resolving admin from a
 * remote signer's bare handle would grant provider admin to anyone who runs a
 * provider and registers the admin's handle there.
 */
export function requireAdmin(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const { config, db } = c.var;
    // Rejects an unauthenticated (401), remote, or provider-signed (403) caller.
    const handle = requireLocalHandle(c);
    if (!isProviderAdmin(db, config, handle)) {
      throw AppError.forbidden({ detail: "provider administrator privileges required" });
    }
    await next();
  };
}
