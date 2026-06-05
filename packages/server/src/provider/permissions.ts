/**
 * Central group permission resolver (spec §5.2).
 *
 * Other cards (channels, messaging, invites, membership) authorize against this
 * module, so the rules live in exactly one place. Two concerns:
 *
 *  1. **Membership lookup** — {@link getMembership} / {@link isMember} answer
 *     "what role (if any) does this actor hold in this group?".
 *  2. **Action authorization** — {@link can} answers "may a holder of this role
 *     perform this action in this group?", per the group's `permissions` map.
 *
 * ## Roles & rank-inheritance
 * Canonical roles are ranked: `owner(3) > admin(2) > member(1) > guest(0)`.
 * `group.permissions[action]` lists the roles permitted to perform `action`
 * (e.g. `post: ["member"]`). We treat that list as a **minimum rank**: an actor
 * is permitted iff its role rank is >= the lowest rank among the listed roles.
 * This gives rank-inheritance — `post: ["member"]` means member *and everyone
 * above* (admin, owner) may post, without listing each higher role. The
 * **owner** is always allowed, regardless of the permission map.
 *
 * Providers MAY define extra actions or roles (§5.2). Unknown roles (whether in
 * the actor's membership row or in a group's permission list) are treated as the
 * lowest rank, so they fail closed rather than crash.
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { groupMembers } from "../db/schema.ts";
import { getGroupRow, rowToGroup } from "./groups.ts";

/** A canonical action that the permission map gates. Providers MAY add more. */
export type Action = "post" | "moderate" | "manage";

/**
 * Canonical role rank. Higher rank = more authority. Unknown/unlisted roles map
 * to the lowest rank (deny) via {@link rankOf}.
 */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  member: 1,
  guest: 0,
};

/**
 * Rank of a role string; unknown roles → -1 (below every canonical role).
 * Exported so the membership card can compare ranks for kick/promote rules
 * (target MUST NOT outrank the caller; single-owner transfer).
 */
export function rankOf(role: string): number {
  return ROLE_RANK[role] ?? -1;
}

/** The minimal shape of a group needed for an authorization decision. */
export interface PermissionGroup {
  /** Action → permitted roles map (`group.permissions`). */
  readonly permissions: Record<string, readonly string[] | undefined>;
}

/** A membership record (the actor's role in a group). */
export interface Membership {
  readonly role: string;
}

/**
 * The actor's membership in `groupId`, or `null` if they are not a member.
 * `actor` is the canonical `handle@domain` string.
 */
export function getMembership(db: Db, groupId: string, actor: string): Membership | null {
  const row = db.drizzle
    .select({ role: groupMembers.role })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.user, actor)))
    .limit(1)
    .all()[0];
  return row ? { role: row.role } : null;
}

/** Whether `actor` is a member of `groupId` (any role). */
export function isMember(db: Db, groupId: string, actor: string): boolean {
  return getMembership(db, groupId, actor) !== null;
}

/**
 * Whether a holder of `role` may perform `action` in `group`, per the
 * rank-inheritance rule documented at the top of this file:
 *
 *  - the **owner** is always allowed;
 *  - otherwise the action is permitted iff `rankOf(role)` is >= the **minimum**
 *    rank among the roles listed in `group.permissions[action]`.
 *
 * If the action is not present in the map (or lists no roles), nobody but the
 * owner may perform it (fail closed). Unknown roles rank below `guest` and are
 * denied.
 */
export function can(action: Action, role: string, group: PermissionGroup): boolean {
  // Owner is always allowed, independent of the permission map.
  if (role === "owner") return true;

  const allowed = group.permissions[action];
  if (!allowed || allowed.length === 0) return false;

  // The lowest-ranked listed role is the minimum bar; rank-inheritance means any
  // role at or above that bar qualifies. Unknown listed roles (rank -1) never
  // lower the bar below a real role here because we take the min over them too —
  // but an all-unknown list yields a -1 bar, which only unknown actors (also -1)
  // would meet; canonical roles still satisfy >= -1, so an all-unknown list
  // effectively allows any known member. To keep "unknown denies", require the
  // bar to come from at least one recognized role.
  let minRank = Number.POSITIVE_INFINITY;
  for (const r of allowed) {
    const rank = rankOf(r);
    if (rank >= 0 && rank < minRank) minRank = rank;
  }
  if (!Number.isFinite(minRank)) return false; // no recognized role listed → deny

  return rankOf(role) >= minRank;
}

/**
 * Convenience: load `groupId`, look up `actor`'s membership, and decide whether
 * they may perform `action`. Returns false if the group is unknown or the actor
 * is not a member. Combines {@link getMembership} + {@link can}.
 */
export function canActor(db: Db, action: Action, groupId: string, actor: string): boolean {
  const row = getGroupRow(db, groupId);
  if (!row) return false;
  const membership = getMembership(db, groupId, actor);
  if (!membership) return false;
  return can(action, membership.role, rowToGroup(row));
}
