/**
 * `/api/provider` router — provider branding (Forumall extension, not OFSCP).
 *
 *  - `GET /api/provider` — PUBLIC (unauthenticated). Returns the instance's
 *    branding `{ domain, name, iconUrl, accentColor }` so the web client can
 *    apply the page title / favicon / accent on boot, possibly pre-login.
 *  - `PUT /api/provider` — admin-only (`requireSignature` + `requireAdmin`).
 *    Body `{ name?, iconUrl?, accentColor? }` (partial); upserts the provided
 *    keys and returns the full branding. A `null`/empty value clears a field.
 *
 * The icon image itself is uploaded through the EXISTING `/api/media` endpoint;
 * this router only stores the resulting URL (see `provider/branding.ts`).
 */
import { Hono } from "hono";

import { getBranding, setBranding } from "../provider/branding.ts";
import { type GroupCreationPolicy, getGroupCreationPolicy } from "../provider/group-policy.ts";
import { requireAdmin } from "./admin-guard.ts";
import { AppError } from "./errors.ts";
import { requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Shape of the public branding response. */
interface BrandingResponse {
  domain: string;
  name: string;
  iconUrl: string | null;
  accentColor: string | null;
  /** Who may create groups on this instance (Forumall extension). */
  groupCreationPolicy: GroupCreationPolicy;
}

export function createProviderRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  /** GET /api/provider — public branding read. */
  router.get("/", (c) => {
    const { config, db } = c.var;
    const branding = getBranding(db, config);
    const body: BrandingResponse = {
      domain: config.domain,
      name: branding.name,
      iconUrl: branding.iconUrl,
      accentColor: branding.accentColor,
      groupCreationPolicy: getGroupCreationPolicy(db),
    };
    return c.json(body);
  });

  /** PUT /api/provider — admin-only branding update (partial). */
  router.put("/", signed, requireAdmin(), async (c) => {
    const { config, db } = c.var;
    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be JSON" });
    });
    if (typeof raw !== "object" || raw === null) {
      throw AppError.badRequest({ detail: "request body must be a JSON object" });
    }
    const patch = raw as Record<string, unknown>;

    // Only forward keys that are actually present (an omitted key is untouched).
    const next: { name?: string | null; iconUrl?: string | null; accentColor?: string | null } = {};
    if ("name" in patch) next.name = asNullableString(patch.name, "name");
    if ("iconUrl" in patch) next.iconUrl = asNullableString(patch.iconUrl, "iconUrl");
    if ("accentColor" in patch) {
      next.accentColor = asNullableString(patch.accentColor, "accentColor");
    }

    const branding = setBranding(db, config, next);
    const body: BrandingResponse = {
      domain: config.domain,
      name: branding.name,
      iconUrl: branding.iconUrl,
      accentColor: branding.accentColor,
      groupCreationPolicy: getGroupCreationPolicy(db),
    };
    return c.json(body);
  });

  return router;
}

/** Coerce a JSON value to `string | null`, rejecting other types. */
function asNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw AppError.badRequest({ detail: `${field} must be a string or null` });
}
