/**
 * Privacy-settings storage + defaults (spec §6.6).
 *
 * Owns the `privacy_settings` row lifecycle and the row ↔ resolved-settings
 * mapping, keeping the HTTP layer thin. The resolved shape feeds both the
 * `GET/PUT /api/me/privacy` endpoints and the visibility resolver
 * (`provider/visibility.ts`) that the profile, membership, and presence cards
 * gate on.
 *
 * ## Defaults (documented)
 * When a user has no `privacy_settings` row, the provider serves these defaults:
 *
 *  - `presenceVisibility`   → `sharedGroups`  (presence is moderately sensitive;
 *    shared-group peers see it, the wider world does not).
 *  - `profileVisibility`    → `public`        (profile extras like bio are part
 *    of a public-facing identity).
 *  - `membershipVisibility` → `authenticated` (which groups you are in is shared
 *    with signed-in users but not anonymous/unauthenticated callers).
 *  - `allowList` / `denyList` → empty.
 *
 * These are deliberately middle-of-the-road; a user tightens or loosens them via
 * `PUT /api/me/privacy`.
 */
import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type PrivacySettingsRow, privacySettings } from "../db/schema.ts";
import type { VisibilityPolicyValue } from "./visibility.ts";

/** A user's resolved privacy settings (with defaults applied). */
export interface ResolvedPrivacySettings {
  readonly presenceVisibility: VisibilityPolicyValue;
  readonly profileVisibility: VisibilityPolicyValue;
  readonly membershipVisibility: VisibilityPolicyValue;
  readonly allowList: string[];
  readonly denyList: string[];
}

/** The documented defaults served when a user has no `privacy_settings` row. */
export const DEFAULT_PRIVACY: ResolvedPrivacySettings = {
  presenceVisibility: "sharedGroups",
  profileVisibility: "public",
  membershipVisibility: "authenticated",
  allowList: [],
  denyList: [],
};

/** Parse a JSON `string[]` column, tolerating malformed/empty values. */
function parseActorList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

/** Map a stored row to resolved settings. */
function rowToSettings(row: PrivacySettingsRow): ResolvedPrivacySettings {
  return {
    presenceVisibility: row.presenceVisibility as VisibilityPolicyValue,
    profileVisibility: row.profileVisibility as VisibilityPolicyValue,
    membershipVisibility: row.membershipVisibility as VisibilityPolicyValue,
    allowList: parseActorList(row.allowList),
    denyList: parseActorList(row.denyList),
  };
}

/** The raw privacy-settings row for `handle`, or `null` if unset. */
export function getPrivacyRow(db: Db, handle: string): PrivacySettingsRow | null {
  return (
    db.drizzle
      .select()
      .from(privacySettings)
      .where(eq(privacySettings.handle, handle))
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * The user's resolved privacy settings, with {@link DEFAULT_PRIVACY} filled in
 * when there is no stored row. The presence card consumes this to gate
 * `GET /api/users/{ref}/presence`.
 */
export function getPrivacySettings(db: Db, handle: string): ResolvedPrivacySettings {
  const row = getPrivacyRow(db, handle);
  return row ? rowToSettings(row) : { ...DEFAULT_PRIVACY };
}

/** Fields a caller may change on `PUT /api/me/privacy` (all optional). */
export interface PrivacyUpdate {
  readonly presenceVisibility?: VisibilityPolicyValue;
  readonly profileVisibility?: VisibilityPolicyValue;
  readonly membershipVisibility?: VisibilityPolicyValue;
  readonly allowList?: readonly string[];
  readonly denyList?: readonly string[];
}

/**
 * Apply a partial update over the user's current settings (defaults when unset)
 * and persist the full resulting row. Returns the resolved settings.
 */
export function updatePrivacySettings(
  db: Db,
  handle: string,
  update: PrivacyUpdate,
): ResolvedPrivacySettings {
  const current = getPrivacySettings(db, handle);
  const next: ResolvedPrivacySettings = {
    presenceVisibility: update.presenceVisibility ?? current.presenceVisibility,
    profileVisibility: update.profileVisibility ?? current.profileVisibility,
    membershipVisibility: update.membershipVisibility ?? current.membershipVisibility,
    allowList: update.allowList ? [...update.allowList] : current.allowList,
    denyList: update.denyList ? [...update.denyList] : current.denyList,
  };

  const row: PrivacySettingsRow = {
    handle,
    presenceVisibility: next.presenceVisibility,
    profileVisibility: next.profileVisibility,
    membershipVisibility: next.membershipVisibility,
    allowList: JSON.stringify(next.allowList),
    denyList: JSON.stringify(next.denyList),
    updatedAt: Date.now(),
  };

  db.drizzle
    .insert(privacySettings)
    .values(row)
    .onConflictDoUpdate({
      target: privacySettings.handle,
      set: {
        presenceVisibility: row.presenceVisibility,
        profileVisibility: row.profileVisibility,
        membershipVisibility: row.membershipVisibility,
        allowList: row.allowList,
        denyList: row.denyList,
        updatedAt: row.updatedAt,
      },
    })
    .run();

  return next;
}
