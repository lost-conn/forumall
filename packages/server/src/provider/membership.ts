/**
 * Membership + join-request storage and canonical-shape mapping (spec §5.7).
 *
 * Owns the persistence helpers the membership router builds on, keeping the HTTP
 * layer thin: row ↔ canonical `Member` / `JoinRequest` translation, the
 * join/leave/role-change/kick mutations, the pending-join-request lifecycle, and
 * the opaque-cursor member listing (§7.2). Authorization (group `manage` /
 * `moderate`, role-rank rules) is decided by the HTTP layer via
 * `provider/permissions.ts`; this module owns the `group_members` /
 * `join_requests` row lifecycle and the single-owner invariant on transfer.
 *
 * ## Pagination
 * {@link encodeCursor} / {@link decodeCursor} implement the §7.2 opaque cursor as
 * a base64url-encoded keyset position. They are generic over the keyset tuple so
 * later message/DM cards reuse the same helper rather than re-deriving a cursor
 * scheme. For members the keyset is `(joinedAt, user)` — a stable, total order
 * (the unique `user` breaks `joinedAt` ties), so paging never overlaps or skips
 * even when many members share a `joinedAt`.
 */
import {
  type JoinRequest,
  JoinRequestSchema,
  type Member,
  MemberSchema,
  rfc3339Timestamp,
} from "@forumall/shared";
import { and, eq, or, sql } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import {
  type GroupMemberRow,
  type JoinRequestRow,
  groupMembers,
  joinRequests,
} from "../db/schema.ts";

/** `id` prefix for a join request per the §5.2 id convention (`jrq_…`). */
const JOIN_REQUEST_ID_PREFIX = "jrq_";
/** Random bytes of entropy for a join-request id (16 = 128 bits). */
const JOIN_REQUEST_ID_BYTES = 16;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint a provider-generated join-request id (`jrq_<base64url>`). */
function mintJoinRequestId(): string {
  const raw = new Uint8Array(JOIN_REQUEST_ID_BYTES);
  crypto.getRandomValues(raw);
  return `${JOIN_REQUEST_ID_PREFIX}${toBase64Url(raw)}`;
}

// ---------------------------------------------------------------------------
// Opaque cursor (§7.2) — reusable keyset codec for later message/DM cards.
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary keyset position as an opaque base64url cursor (§7.2).
 * The position is JSON-serialized then base64url-encoded, so the cursor is an
 * opaque string to clients but a stable, decodable keyset to the server. Reuse
 * this for any keyset-paginated list (members, messages, DMs).
 */
export function encodeCursor(position: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(position)));
}

/**
 * Decode an opaque cursor produced by {@link encodeCursor} back into its keyset
 * position, or `null` if it is malformed (a forged/garbage cursor is treated as
 * "no cursor" by the caller rather than crashing).
 */
export function decodeCursor<T>(cursor: string): T | null {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Member mapping + queries
// ---------------------------------------------------------------------------

/** Map a stored membership row to the canonical, schema-valid `Member` (§5.7). */
export function rowToMember(row: GroupMemberRow): Member {
  return MemberSchema.parse({
    user: row.user,
    role: row.role,
    joinedAt: rfc3339Timestamp(new Date(row.joinedAt)),
  });
}

/** The raw membership row for (groupId, user), or `null` if not a member. */
export function getMemberRow(db: Db, groupId: string, user: string): GroupMemberRow | null {
  return (
    db.drizzle
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.user, user)))
      .limit(1)
      .all()[0] ?? null
  );
}

/** The single owner row of `groupId` (the single-owner invariant holds), or null. */
export function getOwnerRow(db: Db, groupId: string): GroupMemberRow | null {
  return (
    db.drizzle
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "owner")))
      .limit(1)
      .all()[0] ?? null
  );
}

/** Keyset position for the member listing: `(joinedAt, user)` — a total order. */
interface MemberCursor {
  readonly joinedAt: number;
  readonly user: string;
}

export interface MemberPage {
  readonly items: Member[];
  /** Opaque cursor for the next page, or `null` when this is the last page. */
  readonly nextCursor: string | null;
}

/**
 * List members of `groupId` ordered by `(joinedAt, user)`, one page at a time
 * (§7.2). `limit` items are returned; if more exist, `nextCursor` is the opaque
 * cursor for the page after the last returned item. A malformed `cursor` is
 * treated as the first page.
 *
 * Membership-visibility hiding (§6) is a **P6** concern: members who have hidden
 * their membership SHOULD be omitted for unauthorized viewers. There is no
 * profile/visibility store yet, so every member is listed for now — filter here
 * (post-fetch, before slicing to `limit`) once §6 lands.
 */
export function listMembersPage(
  db: Db,
  groupId: string,
  limit: number,
  cursor: string | null,
): MemberPage {
  const after = cursor ? decodeCursor<MemberCursor>(cursor) : null;

  // Keyset predicate: rows strictly after (joinedAt, user) in the total order.
  // (joinedAt > a) OR (joinedAt = a AND user > u).
  const where = after
    ? and(
        eq(groupMembers.groupId, groupId),
        or(
          sql`${groupMembers.joinedAt} > ${after.joinedAt}`,
          and(eq(groupMembers.joinedAt, after.joinedAt), sql`${groupMembers.user} > ${after.user}`),
        ),
      )
    : eq(groupMembers.groupId, groupId);

  // Fetch one extra row to detect whether a further page exists.
  const rows = db.drizzle
    .select()
    .from(groupMembers)
    .where(where)
    .orderBy(groupMembers.joinedAt, groupMembers.user)
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  // P6 hook: filter `pageRows` by membership visibility for the viewer here.
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ joinedAt: last.joinedAt, user: last.user }) : null;

  return { items: pageRows.map(rowToMember), nextCursor };
}

/** Every group id `user` is a member of (any role), as a `Set` for fast lookup. */
export function groupIdsOf(db: Db, user: string): Set<string> {
  const rows = db.drizzle
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.user, user))
    .all();
  return new Set(rows.map((r) => r.groupId));
}

/**
 * Whether `a` and `b` share at least one group (the §6.1 `sharedGroups` tier).
 * Side-effect-free; both arguments are canonical `handle@domain` actors.
 */
export function sharesGroupWith(db: Db, a: string, b: string): boolean {
  if (a === b) return true;
  const aGroups = groupIdsOf(db, a);
  if (aGroups.size === 0) return false;
  const bRows = db.drizzle
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.user, b))
    .all();
  return bRows.some((r) => aGroups.has(r.groupId));
}

// ---------------------------------------------------------------------------
// Membership mutations
// ---------------------------------------------------------------------------

/**
 * Insert `user` into `groupId` with `role` (default `member`) and return the
 * canonical `Member`. Caller guarantees the user is not already a member.
 */
export function addMember(db: Db, groupId: string, user: string, role = "member"): Member {
  const row: GroupMemberRow = { groupId, user, role, joinedAt: Date.now() };
  db.drizzle.insert(groupMembers).values(row).run();
  return rowToMember(row);
}

/** Remove `user`'s membership from `groupId`. Idempotent (no-op if absent). */
export function removeMember(db: Db, groupId: string, user: string): void {
  db.drizzle
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.user, user)))
    .run();
}

/** Set `user`'s role in `groupId`. Caller guarantees the user is a member. */
export function setMemberRole(db: Db, groupId: string, user: string, role: string): Member {
  db.drizzle
    .update(groupMembers)
    .set({ role })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.user, user)))
    .run();
  return rowToMember(getMemberRow(db, groupId, user) as GroupMemberRow);
}

/**
 * Transfer ownership of `groupId` to `newOwner` atomically, enforcing the
 * single-owner invariant: the current owner is demoted to `admin` and
 * `newOwner` is promoted to `owner` in one transaction. Caller guarantees
 * `newOwner` is an existing member and the actor is the current owner. Returns
 * the new owner's canonical `Member`.
 */
export function transferOwnership(db: Db, groupId: string, newOwner: string): Member {
  db.sqlite.transaction(() => {
    // Demote every current owner (there is exactly one) to admin, then promote.
    db.drizzle
      .update(groupMembers)
      .set({ role: "admin" })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "owner")))
      .run();
    db.drizzle
      .update(groupMembers)
      .set({ role: "owner" })
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.user, newOwner)))
      .run();
  })();
  return rowToMember(getMemberRow(db, groupId, newOwner) as GroupMemberRow);
}

// ---------------------------------------------------------------------------
// Join requests (§5.7, `request` policy)
// ---------------------------------------------------------------------------

/** Map a stored join-request row to the canonical, schema-valid `JoinRequest`. */
export function rowToJoinRequest(row: JoinRequestRow): JoinRequest {
  return JoinRequestSchema.parse({
    id: row.id,
    groupId: row.groupId,
    user: row.user,
    state: row.state,
    ...(row.message != null ? { message: row.message } : {}),
    requestedAt: rfc3339Timestamp(new Date(row.requestedAt)),
  });
}

/** The raw join-request row for `requestId`, or `null` if there is none. */
export function getJoinRequestRow(db: Db, requestId: string): JoinRequestRow | null {
  return (
    db.drizzle
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.id, requestId))
      .limit(1)
      .all()[0] ?? null
  );
}

/** The actor's pending join request in `groupId`, or `null` if none is pending. */
export function getPendingJoinRequest(
  db: Db,
  groupId: string,
  user: string,
): JoinRequestRow | null {
  return (
    db.drizzle
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.groupId, groupId),
          eq(joinRequests.user, user),
          eq(joinRequests.state, "pending"),
        ),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

/**
 * Record a pending join request for `user` in `groupId`, idempotently: if the
 * actor already has a pending request, return it unchanged rather than inserting
 * a duplicate. Returns the canonical `JoinRequest`.
 */
export function requestToJoin(
  db: Db,
  groupId: string,
  user: string,
  message?: string,
): JoinRequest {
  const existing = getPendingJoinRequest(db, groupId, user);
  if (existing) return rowToJoinRequest(existing);

  const row: JoinRequestRow = {
    id: mintJoinRequestId(),
    groupId,
    user,
    state: "pending",
    message: message ?? null,
    requestedAt: Date.now(),
  };
  db.drizzle.insert(joinRequests).values(row).run();
  return rowToJoinRequest(row);
}

/** All pending join requests for `groupId`, oldest first. */
export function listPendingJoinRequests(db: Db, groupId: string): JoinRequest[] {
  return db.drizzle
    .select()
    .from(joinRequests)
    .where(and(eq(joinRequests.groupId, groupId), eq(joinRequests.state, "pending")))
    .orderBy(joinRequests.requestedAt)
    .all()
    .map(rowToJoinRequest);
}

/**
 * Approve `requestId`: mark it `approved` and add its user as a `member`,
 * atomically. Returns the new `Member`. Caller guarantees the request exists,
 * is pending, and belongs to `groupId`. If the user is somehow already a member,
 * their existing membership is returned unchanged (the request is still marked
 * approved).
 */
export function approveJoinRequest(db: Db, row: JoinRequestRow): Member {
  let member!: Member;
  db.sqlite.transaction(() => {
    db.drizzle
      .update(joinRequests)
      .set({ state: "approved" })
      .where(eq(joinRequests.id, row.id))
      .run();
    const existing = getMemberRow(db, row.groupId, row.user);
    member = existing ? rowToMember(existing) : addMember(db, row.groupId, row.user, "member");
  })();
  return member;
}

/** Deny `requestId`: mark it `denied`. Caller guarantees it exists + is pending. */
export function denyJoinRequest(db: Db, requestId: string): void {
  db.drizzle
    .update(joinRequests)
    .set({ state: "denied" })
    .where(eq(joinRequests.id, requestId))
    .run();
}
