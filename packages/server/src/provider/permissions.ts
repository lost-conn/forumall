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
 * ## Roles & explicit grants (§5.2)
 * `group.permissions[action]` lists the **exact** set of roles permitted to
 * perform `action` (e.g. `post: ["admin", "member"]`). A role may perform an
 * action **iff it is listed** — there is **no rank inheritance**. The **owner**
 * is the single exception: it implicitly holds every permission and is always
 * allowed. Because grants are explicit, powers need not be nested — a group may
 * define a role that may `moderate` but not `post`.
 *
 * Groups MAY declare custom roles via their `roles` catalogue (§5.2); a role's
 * permissions are still resolved from the `permissions` map, not the catalogue.
 * Unknown roles (not canonical, not in the catalogue, not listed for any action)
 * simply hold nothing, so they fail closed rather than crash.
 *
 * ## Subset (self-protect) rule
 * Kick / role-change are constrained by {@link roleHoldsAll}: a caller may act on
 * a target only when the caller holds *every* permission the target holds. The
 * owner holds everything (acts on anyone; no one acts on the owner).
 */
import type { ChannelPermissions } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { groupMembers } from "../db/schema.ts";
import { getGroupRow, rowToGroup } from "./groups.ts";

/**
 * A canonical action that the permission map gates. Providers MAY add more.
 *
 * `members.set-nickname` is a Forumall extension action (Overboard "Per-group
 * display name"): holding it lets a member set/clear ANOTHER member's per-group
 * `displayNameOverride` (in addition to the subset/self-protect rule). Setting
 * one's OWN nickname needs no permission. Like every action it is resolved by
 * exact membership against `group.permissions["members.set-nickname"]`.
 */
export type Action = "post" | "moderate" | "manage" | "members.set-nickname";

/** A postable message kind (§5.3); the per-channel `post:<kind>` actions. */
export type MessageKind = "message" | "memo" | "article";

/**
 * The canonical roles (§5.2). They always exist regardless of a group's `roles`
 * catalogue; `owner` is the reserved super-role (holds every permission).
 */
export const CANONICAL_ROLES = ["owner", "admin", "member", "guest"] as const;

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
 * exact-membership rule documented at the top of this file:
 *
 *  - the **owner** is always allowed;
 *  - otherwise the action is permitted iff `role` is listed verbatim in
 *    `group.permissions[action]` (no rank inheritance).
 *
 * If the action is not present in the map (or lists no roles), nobody but the
 * owner may perform it (fail closed).
 */
export function can(action: Action, role: string, group: PermissionGroup): boolean {
  return roleMeets(role, group.permissions[action]);
}

/**
 * Core exact-membership test (§5.2): may a holder of `role` act, given the list
 * of permitted roles? The **owner** is always allowed. Otherwise the role must
 * appear in `allowed` verbatim — no rank inheritance. An absent/empty list
 * denies everyone but the owner (fail closed). Shared by group {@link can} and
 * the per-channel resolvers ({@link canPostKind}, {@link canReact}).
 */
export function roleMeets(role: string, allowed: readonly string[] | undefined): boolean {
  if (role === "owner") return true;
  return allowed?.includes(role) ?? false;
}

/**
 * The set of group actions a holder of `role` is granted — its **permission
 * set** (§5.2): every action whose permission list names the role. The `owner`
 * implicitly holds every action present in the map. Backs the subset rule.
 */
export function grantsOf(role: string, group: PermissionGroup): Set<string> {
  const actions = Object.keys(group.permissions);
  if (role === "owner") return new Set(actions);
  const held = new Set<string>();
  for (const action of actions) {
    if (group.permissions[action]?.includes(role)) held.add(action);
  }
  return held;
}

/**
 * The §5.7 **subset (self-protect) rule**: does `callerRole` hold every
 * permission `targetRole` holds? A caller may kick or change the role of a
 * target only when this is true (and, for a role change, also for the role being
 * assigned). The `owner` holds everything — it always passes, and nothing
 * passes against it.
 */
export function roleHoldsAll(
  callerRole: string,
  targetRole: string,
  group: PermissionGroup,
): boolean {
  if (callerRole === "owner") return true;
  if (targetRole === "owner") return false;
  const caller = grantsOf(callerRole, group);
  for (const action of grantsOf(targetRole, group)) {
    if (!caller.has(action)) return false;
  }
  return true;
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
 * group's `post` action. Exact-membership via {@link roleMeets}.
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
 * actor may post only as a reply. True iff the actor's role is listed verbatim
 * in `replyOnly` — the **owner is never restricted**. (e.g.
 * `replyOnly: ["member", "guest"]` restricts member and guest.)
 */
export function isReplyRestricted(role: string, perms: ChannelPermissions | null): boolean {
  if (role === "owner") return false;
  return perms?.replyOnly?.includes(role) ?? false;
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
