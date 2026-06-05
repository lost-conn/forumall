/**
 * Invite / join-link storage and canonical-shape mapping (spec §5.6).
 *
 * Owns the persistence helpers the invite + redemption routers build on, keeping
 * the HTTP layer thin: row ↔ canonical `Invite` translation, invite creation
 * (minting a high-entropy `token`), lookup by id or token, revocation, and the
 * atomic redemption counter (`uses`/`maxUses`). Authorization (group `manage`)
 * and the actual membership mutation are the HTTP/membership layer's concern;
 * this module owns the `invites` row lifecycle and the use-count invariant.
 */
import { type Invite, InviteSchema, rfc3339Timestamp } from "@forumall/shared";
import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { type InviteRow, invites } from "../db/schema.ts";

/** `id` prefix per the §5.2 id convention (`inv_…`). */
const INVITE_ID_PREFIX = "inv_";
/** Random bytes of entropy for an invite id (16 = 128 bits). */
const INVITE_ID_BYTES = 16;
/** Random bytes of entropy for the opaque join-link token (32 = 256 bits). */
const INVITE_TOKEN_BYTES = 32;

/** Base64url-encode (URL-safe, no padding) for an opaque id / token body. */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated invite id (`inv_<base64url>`). */
function mintInviteId(): string {
  const raw = new Uint8Array(INVITE_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${INVITE_ID_PREFIX}${toBase64Url(raw)}`;
}

/** Mint a high-entropy opaque invite token (base64url, 256 bits). */
function mintInviteToken(): string {
  const raw = new Uint8Array(INVITE_TOKEN_BYTES);
  crypto.getRandomValues(raw);
  return toBase64Url(raw);
}

/** Map a stored invite row to the canonical, schema-valid `Invite` (§5.6). */
export function rowToInvite(row: InviteRow): Invite {
  return InviteSchema.parse({
    id: row.id,
    groupId: row.groupId,
    ...(row.channelId != null ? { channelId: row.channelId } : {}),
    token: row.token,
    role: row.role,
    grantsGuest: row.grantsGuest,
    ...(row.maxUses != null ? { maxUses: row.maxUses } : {}),
    uses: row.uses,
    ...(row.expiresAt != null ? { expiresAt: rfc3339Timestamp(new Date(row.expiresAt)) } : {}),
    createdBy: row.createdBy,
    createdAt: rfc3339Timestamp(new Date(row.createdAt)),
  });
}

/** Fields an invite is created with (post-validation, defaults applied). */
export interface CreateInviteInput {
  readonly channelId?: string | undefined;
  readonly role?: string | undefined;
  readonly grantsGuest?: boolean | undefined;
  readonly maxUses?: number | undefined;
  /** Expiry as epoch millis, or undefined for no expiry. */
  readonly expiresAt?: number | undefined;
}

/**
 * Create an invite for `groupId` minted by `createdBy`, applying §5.6 defaults
 * (role `member`, `grantsGuest` false). Returns the stored row.
 */
export function createInvite(
  db: Db,
  groupId: string,
  createdBy: string,
  input: CreateInviteInput,
): InviteRow {
  const row: InviteRow = {
    id: mintInviteId(),
    groupId,
    token: mintInviteToken(),
    channelId: input.channelId ?? null,
    role: input.role ?? "member",
    grantsGuest: input.grantsGuest ?? false,
    maxUses: input.maxUses ?? null,
    uses: 0,
    expiresAt: input.expiresAt ?? null,
    createdBy,
    createdAt: Date.now(),
  };
  db.drizzle.insert(invites).values(row).run();
  return row;
}

/** The raw invite row for `inviteId`, or `null` if there is none. */
export function getInviteRow(db: Db, inviteId: string): InviteRow | null {
  return (
    db.drizzle.select().from(invites).where(eq(invites.id, inviteId)).limit(1).all()[0] ?? null
  );
}

/** The raw invite row for an opaque `token`, or `null` if there is none. */
export function getInviteByToken(db: Db, token: string): InviteRow | null {
  return (
    db.drizzle.select().from(invites).where(eq(invites.token, token)).limit(1).all()[0] ?? null
  );
}

/** All invites for `groupId`, newest first. */
export function listInvites(db: Db, groupId: string): Invite[] {
  return db.drizzle
    .select()
    .from(invites)
    .where(eq(invites.groupId, groupId))
    .orderBy(sql`${invites.createdAt} DESC`)
    .all()
    .map(rowToInvite);
}

/** Revoke (delete) `inviteId`. Returns true if a row was removed. */
export function deleteInvite(db: Db, inviteId: string): boolean {
  const result = db.sqlite.prepare("DELETE FROM invites WHERE id = ?").run(inviteId);
  return result.changes > 0;
}

/** Whether an invite is expired (has an `expires_at` in the past). */
export function isInviteExpired(row: InviteRow, now = Date.now()): boolean {
  return row.expiresAt != null && now >= row.expiresAt;
}

/** Outcome of {@link consumeInviteUse}. */
export type ConsumeUseResult = "ok" | "exhausted";

/**
 * Atomically increment `uses` for `inviteId`, respecting `max_uses`. The update
 * is conditional (`uses < max_uses OR max_uses IS NULL`) and scoped to the id,
 * so concurrent redemptions can never exceed `max_uses`. Returns `"ok"` if a
 * use was consumed, `"exhausted"` if the cap was already reached.
 *
 * The caller is responsible for the expiry check (404) before calling this; a
 * use is only consumed once the redemption is otherwise authorized.
 */
export function consumeInviteUse(db: Db, inviteId: string): ConsumeUseResult {
  const result = db.sqlite
    .prepare(
      "UPDATE invites SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)",
    )
    .run(inviteId);
  return result.changes > 0 ? "ok" : "exhausted";
}
