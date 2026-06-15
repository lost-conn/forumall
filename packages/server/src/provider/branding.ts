/**
 * Provider branding — instance name / icon / accent color (Forumall extension,
 * not part of OFSCP).
 *
 * The provider admin (see `provider/admin.ts`) may customize how this instance
 * presents itself to its members: a display `name`, an `iconUrl` (a media URL
 * produced by the existing `/api/media` upload pipeline), and an `accentColor`
 * (`#rrggbb`) the web client applies as its primary accent CSS variable.
 *
 * Storage is the `app_meta` key/value table — no dedicated table / migration is
 * needed. Each field is one row under a `branding.*` key; an absent row means
 * "unset" (the read falls back to documented defaults). The public read endpoint
 * `GET /api/provider` surfaces these so the web client can apply them on boot,
 * possibly pre-login.
 */
import { eq } from "drizzle-orm";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { appMeta } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";

/** `app_meta` keys backing each branding field. */
const KEY_NAME = "branding.name";
const KEY_ICON = "branding.iconUrl";
const KEY_ACCENT = "branding.accentColor";

/** Resolved branding for a provider. `name` always present; the rest nullable. */
export interface Branding {
  /** Instance display name; falls back to `config.domain` when unset. */
  name: string;
  /** Icon/logo URL (a media URL or absolute https URL); null when unset. */
  iconUrl: string | null;
  /** Primary accent color (`#rrggbb`); null when unset. */
  accentColor: string | null;
}

/** A partial branding patch (any subset of fields). */
export interface BrandingPatch {
  name?: string | null;
  iconUrl?: string | null;
  accentColor?: string | null;
}

/** Max length for the instance display name. */
const MAX_NAME_LENGTH = 80;
/** Max length for an icon URL/path. */
const MAX_ICON_LENGTH = 2048;
/** A strict `#rrggbb` hex color. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** Accepted icon URL forms: a local `/media`/`/api/media` path or an absolute URL. */
const ICON_URL = /^(\/[^\s]*|https?:\/\/[^\s]+)$/;

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

/** Delete a single `app_meta` row (clears a field). */
function deleteMeta(db: Db, key: string): void {
  db.drizzle.delete(appMeta).where(eq(appMeta.key, key)).run();
}

/**
 * The current branding. `name` defaults to `config.domain` when unset; `iconUrl`
 * and `accentColor` are null when unset.
 */
export function getBranding(db: Db, config: Config): Branding {
  const name = readMeta(db, KEY_NAME);
  return {
    name: name && name.length > 0 ? name : config.domain,
    iconUrl: readMeta(db, KEY_ICON) ?? null,
    accentColor: readMeta(db, KEY_ACCENT) ?? null,
  };
}

/**
 * Apply a partial branding patch (admin-only at the HTTP layer). Each provided
 * key is validated then upserted; a `null` (or, for `name`, empty string) clears
 * the field. Keys omitted from the patch are left untouched. Returns the full
 * resolved branding after the write.
 *
 * Validation (throws {@link AppError.badRequest} on failure):
 *  - `name`: non-empty after trim, ≤ {@link MAX_NAME_LENGTH} chars.
 *  - `accentColor`: a strict `#rrggbb` hex.
 *  - `iconUrl`: a local `/media…` path or an absolute http(s) URL, ≤ {@link MAX_ICON_LENGTH}.
 */
export function setBranding(db: Db, config: Config, patch: BrandingPatch): Branding {
  if ("name" in patch) {
    const raw = patch.name;
    if (raw == null || raw.trim().length === 0) {
      // Empty/null name clears the override (read falls back to the domain).
      deleteMeta(db, KEY_NAME);
    } else {
      const name = raw.trim();
      if (name.length > MAX_NAME_LENGTH) {
        throw AppError.badRequest({
          detail: `name must be at most ${MAX_NAME_LENGTH} characters`,
        });
      }
      writeMeta(db, KEY_NAME, name);
    }
  }

  if ("accentColor" in patch) {
    const raw = patch.accentColor;
    if (raw == null || raw.length === 0) {
      deleteMeta(db, KEY_ACCENT);
    } else if (!HEX_COLOR.test(raw)) {
      throw AppError.badRequest({ detail: "accentColor must be a #rrggbb hex color" });
    } else {
      writeMeta(db, KEY_ACCENT, raw.toLowerCase());
    }
  }

  if ("iconUrl" in patch) {
    const raw = patch.iconUrl;
    if (raw == null || raw.length === 0) {
      deleteMeta(db, KEY_ICON);
    } else if (raw.length > MAX_ICON_LENGTH || !ICON_URL.test(raw)) {
      throw AppError.badRequest({
        detail: "iconUrl must be a /media path or an absolute http(s) URL",
      });
    } else {
      writeMeta(db, KEY_ICON, raw);
    }
  }

  return getBranding(db, config);
}
