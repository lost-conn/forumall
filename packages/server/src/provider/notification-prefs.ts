/**
 * Per-channel / per-group notification preferences (a provider-LOCAL extension —
 * NOT in the OFSCP v0.1 object model). Owns the `notification_preferences` row
 * lifecycle and the effective-mode resolution that gates the inbound
 * notifications feed + Web Push (`provider/notifications-feed.ts`,
 * `provider/message-notifications.ts`).
 *
 * ## Modes
 *  - `all`      — notify on EVERY message in the scope.
 *  - `mentions` — notify only on @mention / reply (the default behavior).
 *  - `none`     — muted; notify on nothing.
 *
 * ## Resolution precedence (effective mode for a recipient + channel)
 * explicit CHANNEL pref → else explicit GROUP pref → else default `mentions`.
 * A scope is either a `group` (`scopeId` = `grp_…`) or a `channel`
 * (`scopeId` = `chn_…`). State is keyed on the LOCAL `owner` handle, private +
 * per-account, and never federated (it syncs across the owner's own devices via
 * the signed `/api/me/notification-settings` routes).
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type NotificationPreferenceRow, notificationPreferences } from "../db/schema.ts";

/** The notification modes. */
export const NOTIFICATION_MODES = ["all", "mentions", "none"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];

/** The pref scope kinds. */
export const NOTIFICATION_SCOPE_TYPES = ["group", "channel"] as const;
export type NotificationScopeType = (typeof NOTIFICATION_SCOPE_TYPES)[number];

/** The default effective mode when no channel/group preference exists. */
export const DEFAULT_NOTIFICATION_MODE: NotificationMode = "mentions";

/** `npf_` id prefix + entropy for a notification preference row. */
const PREF_ID_PREFIX = "npf_";
const PREF_ID_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated preference id (`npf_<base64url>`). */
function mintPrefId(): string {
  const raw = new Uint8Array(PREF_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${PREF_ID_PREFIX}${toBase64Url(raw)}`;
}

/** Narrow an arbitrary string to a known `NotificationMode`, else null. */
export function asNotificationMode(value: string): NotificationMode | null {
  return (NOTIFICATION_MODES as readonly string[]).includes(value)
    ? (value as NotificationMode)
    : null;
}

/** Narrow an arbitrary string to a known `NotificationScopeType`, else null. */
export function asScopeType(value: string): NotificationScopeType | null {
  return (NOTIFICATION_SCOPE_TYPES as readonly string[]).includes(value)
    ? (value as NotificationScopeType)
    : null;
}

/** A single preference as surfaced to the owner (no internal id/timestamp). */
export interface NotificationPref {
  readonly scopeType: NotificationScopeType;
  readonly scopeId: string;
  readonly mode: NotificationMode;
}

/** Map a stored row to the owner-facing preference. */
function rowToPref(row: NotificationPreferenceRow): NotificationPref {
  return {
    scopeType: (asScopeType(row.scopeType) ?? "channel") as NotificationScopeType,
    scopeId: row.scopeId,
    mode: (asNotificationMode(row.mode) ?? DEFAULT_NOTIFICATION_MODE) as NotificationMode,
  };
}

/** Look up one preference row, or null. */
function getRow(
  db: Db,
  owner: string,
  scopeType: NotificationScopeType,
  scopeId: string,
): NotificationPreferenceRow | null {
  return (
    db.drizzle
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.owner, owner),
          eq(notificationPreferences.scopeType, scopeType),
          eq(notificationPreferences.scopeId, scopeId),
        ),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

/** All preferences for `owner` (group + channel), in a stable order. */
export function listPrefs(db: Db, owner: string): NotificationPref[] {
  return db.drizzle
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.owner, owner))
    .orderBy(notificationPreferences.scopeType, notificationPreferences.scopeId)
    .all()
    .map(rowToPref);
}

/**
 * Upsert `owner`'s preference for a scope to `mode`. Idempotent against the
 * unique (owner, scopeType, scopeId) index — an existing row is updated in place,
 * otherwise a fresh `npf_…` row is inserted. Returns the resulting preference.
 */
export function setPref(
  db: Db,
  owner: string,
  scopeType: NotificationScopeType,
  scopeId: string,
  mode: NotificationMode,
): NotificationPref {
  const now = Date.now();
  const existing = getRow(db, owner, scopeType, scopeId);
  if (existing) {
    db.drizzle
      .update(notificationPreferences)
      .set({ mode, updatedAt: now })
      .where(eq(notificationPreferences.id, existing.id))
      .run();
  } else {
    db.drizzle
      .insert(notificationPreferences)
      .values({ id: mintPrefId(), owner, scopeType, scopeId, mode, updatedAt: now })
      .run();
  }
  return { scopeType, scopeId, mode };
}

/**
 * Delete `owner`'s preference for a scope (revert to the inherited default).
 * Returns true iff a row was removed.
 */
export function clearPref(
  db: Db,
  owner: string,
  scopeType: NotificationScopeType,
  scopeId: string,
): boolean {
  const res = db.drizzle
    .delete(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.owner, owner),
        eq(notificationPreferences.scopeType, scopeType),
        eq(notificationPreferences.scopeId, scopeId),
      ),
    )
    .run();
  return ((res as unknown as { changes?: number }).changes ?? 0) > 0;
}

/**
 * Resolve the EFFECTIVE notification mode for `owner` in `channelId` (which
 * belongs to `groupId`): explicit channel pref → explicit group pref → default
 * `mentions`. `owner` is the LOCAL recipient handle.
 */
export function getEffectiveMode(
  db: Db,
  owner: string,
  channelId: string,
  groupId: string,
): NotificationMode {
  const channelRow = getRow(db, owner, "channel", channelId);
  if (channelRow) {
    const mode = asNotificationMode(channelRow.mode);
    if (mode) return mode;
  }
  const groupRow = getRow(db, owner, "group", groupId);
  if (groupRow) {
    const mode = asNotificationMode(groupRow.mode);
    if (mode) return mode;
  }
  return DEFAULT_NOTIFICATION_MODE;
}
