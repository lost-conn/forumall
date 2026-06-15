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
 * No routes consume it yet (later cards add the admin surface); it lives here so
 * branding / discover-curation / group-gate can mount it without further
 * plumbing.
 */
import type { MiddlewareHandler } from "hono";

import { isProviderAdmin } from "../provider/admin.ts";
import { AppError } from "./errors.ts";
import type { AppBindings } from "./types.ts";

/** Build the provider-admin authorization middleware (run after `requireSignature`). */
export function requireAdmin(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const { config, db } = c.var;
    const actor = c.var.actor;
    // Unreachable if mounted after requireSignature(), but fail closed.
    if (!actor) {
      throw AppError.unauthorized({ detail: "authentication required" });
    }
    if (!isProviderAdmin(db, config, actor.handle)) {
      throw AppError.forbidden({ detail: "provider administrator privileges required" });
    }
    await next();
  };
}
