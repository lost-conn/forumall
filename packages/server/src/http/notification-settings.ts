/**
 * Per-channel / per-group notification-settings router (a provider-LOCAL
 * extension). Three signed endpoints, mounted at `/api/me`:
 *
 *  - `GET    /api/me/notification-settings` — the caller's stored preferences,
 *    as `{ prefs: [{ scopeType, scopeId, mode }] }`.
 *  - `PUT    /api/me/notification-settings` — body `{ scopeType, scopeId, mode }`;
 *    upsert one preference. Returns the resulting preference row.
 *  - `DELETE /api/me/notification-settings?scopeType=&scopeId=` — clear a
 *    preference (revert to the inherited default). 200 with `{ cleared }`.
 *
 * A preference is the recipient's chosen mode (`all` | `mentions` | `none`) for a
 * scope; the effective mode for a (recipient, channel) resolves channel pref →
 * group pref → default `mentions` (`provider/notification-prefs.ts`). State is
 * private + per-account (a caller only ever touches their own rows) and never
 * federated.
 */
import { Hono } from "hono";

import { getUserRow } from "../provider/guests.ts";
import {
  type NotificationMode,
  type NotificationScopeType,
  asNotificationMode,
  asScopeType,
  clearPref,
  listPrefs,
  setPref,
} from "../provider/notification-prefs.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Reject a scopeId that doesn't carry the prefix expected for its scopeType. */
function assertScopeIdShape(scopeType: NotificationScopeType, scopeId: string): void {
  const trimmed = scopeId.trim();
  if (trimmed.length === 0) throw AppError.badRequest({ detail: "scopeId must be non-empty" });
  const wantPrefix = scopeType === "group" ? "grp_" : "chn_";
  if (!trimmed.startsWith(wantPrefix)) {
    throw AppError.badRequest({
      detail: `scopeId for a ${scopeType} scope must start with "${wantPrefix}"`,
    });
  }
}

/** The caller-facing notification-settings router. Mounted at `/api/me`. */
export function createMeNotificationSettingsRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- GET /api/me/notification-settings (signed) -------------------------
  router.get("/notification-settings", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    return c.json({ prefs: listPrefs(db, actor.handle) }, 200);
  });

  // -- PUT /api/me/notification-settings (signed) -------------------------
  router.put("/notification-settings", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    if (!getUserRow(db, actor.handle)) throw AppError.notFound({ detail: "no such user" });

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    }
    const body = raw as { scopeType?: unknown; scopeId?: unknown; mode?: unknown };

    const scopeType = typeof body.scopeType === "string" ? asScopeType(body.scopeType) : null;
    if (!scopeType) {
      throw AppError.badRequest({ detail: "scopeType must be one of: group, channel" });
    }
    const mode: NotificationMode | null =
      typeof body.mode === "string" ? asNotificationMode(body.mode) : null;
    if (!mode) {
      throw AppError.badRequest({ detail: "mode must be one of: all, mentions, none" });
    }
    if (typeof body.scopeId !== "string") {
      throw AppError.badRequest({ detail: "scopeId is required" });
    }
    assertScopeIdShape(scopeType, body.scopeId);

    const pref = setPref(db, actor.handle, scopeType, body.scopeId.trim(), mode);
    return c.json(pref, 200);
  });

  // -- DELETE /api/me/notification-settings (signed) ----------------------
  router.delete("/notification-settings", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();

    const scopeType = asScopeType(c.req.query("scopeType") ?? "");
    if (!scopeType) {
      throw AppError.badRequest({ detail: "scopeType must be one of: group, channel" });
    }
    const scopeId = c.req.query("scopeId") ?? "";
    assertScopeIdShape(scopeType, scopeId);

    const cleared = clearPref(db, actor.handle, scopeType, scopeId.trim());
    return c.json({ cleared }, 200);
  });

  return router;
}
