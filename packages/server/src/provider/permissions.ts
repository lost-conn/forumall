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
import type { ChannelPermissions } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { groupMembers } from "../db/schema.ts";
import { getGroupRow, rowToGroup } from "./groups.ts";

/** A canonical action that the permission map gates. Providers MAY add more. */
export type Action = "post" | "moderate" | "manage";

/** A postable message kind (§5.3); the per-channel `post:<kind>` actions. */
export type MessageKind = "message" | "memo" | "article";

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
  return roleMeets(role, group.permissions[action]);
}

/**
 * Core rank-inheritance test: may a holder of `role` act, given the list of
 * permitted roles? The **owner** is always allowed. An absent/empty list, or one
 * naming only unrecognized roles, denies everyone but the owner (fail closed).
 * Otherwise the lowest-ranked recognized role in `allowed` is the minimum bar and
 * any role at or above it qualifies. Shared by group {@link can} and the
 * per-channel resolvers ({@link canPostKind}, {@link canReact}).
 */
export function roleMeets(role: string, allowed: readonly string[] | undefined): boolean {
  if (role === "owner") return true;
  if (!allowed || allowed.length === 0) return false;

  let minRank = Number.POSITIVE_INFINITY;
  for (const r of allowed) {
    const rank = rankOf(r);
    if (rank >= 0 && rank < minRank) minRank = rank;
  }
  if (!Number.isFinite(minRank)) return false; // no recognized role listed → deny

  return rankOf(role) >= minRank;
}

/**
 * The context a per-channel posting decision needs (§5.2.1): the actor's group
 * `role`, the channel's parsed `permissions` overrides (or `null` to inherit),
 * and the group's `permissions` map (for fallback). Built by the HTTP/WS layer
 * from the channel row + group row so this module stays DB-free and cycle-free.
 */
export interface ChannelAuthzContext {
  readonly role: string;
  readonly channelPermissions: ChannelPermissions | null;
  readonly groupPermissions: Record<string, readonly string[] | undefined>;
}

/** Read a channel-action role list from the (loosely-typed) overrides object. */
function channelActionRoles(
  perms: ChannelPermissions | null,
  action: string,
): readonly string[] | undefined {
  if (!perms) return undefined;
  const value = (perms as Record<string, unknown>)[action];
  return Array.isArray(value) ? (value as string[]) : undefined;
}

/**
 * May the actor post a message of `kind` in the channel (§5.2.1)? Uses the
 * channel's `post:<kind>` override when present, otherwise falls back to the
 * group's `post` action. Rank-inherited via {@link roleMeets}.
 */
export function canPostKind(ctx: ChannelAuthzContext, kind: MessageKind): boolean {
  const channelRoles = channelActionRoles(ctx.channelPermissions, `post:${kind}`);
  if (channelRoles !== undefined) return roleMeets(ctx.role, channelRoles);
  return roleMeets(ctx.role, ctx.groupPermissions.post);
}

/**
 * May the actor add a reaction in the channel (§5.2.1)? Uses the channel's
 * `react` override when present, otherwise falls back to the group's `post`.
 */
export function canReact(ctx: ChannelAuthzContext): boolean {
  const channelRoles = channelActionRoles(ctx.channelPermissions, "react");
  if (channelRoles !== undefined) return roleMeets(ctx.role, channelRoles);
  return roleMeets(ctx.role, ctx.groupPermissions.post);
}

/**
 * Is the actor *reply-restricted* in the channel (§5.2.1)? A reply-restricted
 * actor may post only as a reply. True iff `replyOnly` is non-empty and the
 * actor's role rank is **≤** the maximum rank among the listed roles — the
 * **owner is never restricted**. (e.g. `replyOnly: ["member"]` restricts member
 * and guest.)
 */
export function isReplyRestricted(role: string, perms: ChannelPermissions | null): boolean {
  if (role === "owner") return false;
  const list = perms?.replyOnly;
  if (!list || list.length === 0) return false;

  let maxRank = Number.NEGATIVE_INFINITY;
  for (const r of list) {
    const rank = rankOf(r);
    if (rank > maxRank) maxRank = rank;
  }
  if (!Number.isFinite(maxRank)) return false;
  return rankOf(role) <= maxRank;
}

/**
 * For a reply-restricted actor, the parent message types they may reply to
 * (`replyOnlyTo`, §5.2.1), or `undefined` when unconstrained (any type).
 */
export function replyOnlyToTypes(perms: ChannelPermissions | null): readonly string[] | undefined {
  const list = perms?.replyOnlyTo;
  return list && list.length > 0 ? list : undefined;
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
