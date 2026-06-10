/**
 * `/api/groups/:groupId/...` membership router (spec §5.7). Mounted under the
 * groups router so every route is group-scoped via the `:groupId` param.
 *
 *  - `POST /join` (signed): join by the group's `joinPolicy` — `open` →
 *    immediate `member` (201 Member); `request` → pending `JoinRequest` (202,
 *    idempotent while pending); `invite` → 403 (redeem an invite, §5.6).
 *  - `POST /leave` (signed): remove own membership (204). The owner MUST transfer
 *    ownership first, else 409.
 *  - `GET /members` (optional auth): paginated `{ items, page: { nextCursor } }`
 *    (§7.2). Visible to members; public/discoverable groups expose it publicly.
 *  - `PATCH /members/{userRef}` (signed; `manage`): change a member's role. The
 *    subset rule (§5.7) applies to both the current and the assigned role (the
 *    caller must hold every permission each holds); the assigned role must be
 *    known (canonical or in the group's `roles`). Transferring `owner` is
 *    owner-only and demotes the old owner to `admin` (single-owner invariant).
 *    → 200 Member.
 *  - `DELETE /members/{userRef}` (signed; `moderate`): kick; the subset rule
 *    (§5.7) applies (caller must hold every permission the target holds); the
 *    owner cannot be kicked. → 204.
 *  - `GET /requests` (signed; `manage`/`moderate`): list pending requests.
 *  - `POST /requests/{requestId}/approve` (signed; `manage`/`moderate`): →
 *    200 Member. `POST /requests/{requestId}/deny`: → 204.
 *
 * Authorization decisions delegate to `provider/permissions.ts`; storage/shape
 * mapping lives in `provider/membership.ts`.
 */
import { type Context, Hono } from "hono";

import type { Member } from "@forumall/shared";
import { listChannelRows } from "../provider/channels.ts";
import { getGroupRow, rowToGroup } from "../provider/groups.ts";
import {
  addMember,
  approveJoinRequest,
  denyJoinRequest,
  getJoinRequestRow,
  getMemberRow,
  listMembersPage,
  listPendingJoinRequests,
  removeMember,
  requestToJoin,
  rowToMember,
  setMemberDisplayName,
  setMemberRole,
  transferOwnership,
} from "../provider/membership.ts";
import {
  CANONICAL_ROLES,
  canActor,
  getMembership,
  isMember,
  roleHoldsAll,
} from "../provider/permissions.ts";
import type { Hub } from "../provider/ws-hub.ts";
import { AppError } from "./errors.ts";
import { optionalSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Max length of a per-group display-name override (mirrors a sane name limit). */
const MAX_DISPLAY_NAME_OVERRIDE = 64;

/**
 * Fan out a `member.updated` event for a group-scoped membership change so live
 * member lists and chat author names re-render. The hub fans by channel/actor,
 * not by group, so we publish to every channel of the group (any group
 * subscriber sees it there) and to the affected member's own connections.
 */
function fanOutMemberUpdated(
  hub: Hub,
  db: AppBindings["Variables"]["db"],
  groupId: string,
  member: Member,
): void {
  const event = { type: "member.updated", data: { groupId, member } } as const;
  for (const channel of listChannelRows(db, groupId)) {
    hub.publishToChannel(channel.id, event);
  }
  hub.publishToActor(member.user, event);
}

/** Tiers whose member list MAY be exposed publicly (§5.7). */
const PUBLIC_TIERS = new Set(["public", "discoverable"]);

/** Default + max page size for the member listing (§7.2). */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Read a path param guaranteed present by the mounted route (`:groupId` from the
 * parent groups router). Mirrors the channels router helper; the empty-string
 * fallback is unreachable for a route whose pattern requires the param.
 */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/**
 * Decode a `{userRef}` path segment to a canonical actor (`handle@domain`). The
 * caller URL-encodes the `@`, so the raw param is percent-encoded; Hono returns
 * it decoded, but we decode defensively in case of double-encoding.
 */
function decodeUserRef(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function createMembershipRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  const optional = optionalSignature();

  // -- POST /api/groups/{groupId}/join (§5.7, signed) ----------------------
  router.post("/join", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable: middleware sets it
    const groupId = requireParam(c, "groupId");

    const group = getGroupRow(db, groupId);
    if (!group) throw AppError.notFound({ detail: "no such group" });

    // Already a member → return their membership (idempotent, 200).
    const existing = getMemberRow(db, groupId, actor.actor);
    if (existing) return c.json(rowToMember(existing), 200);

    // The body is optional; only the `request` policy reads `{ message }`.
    const raw = await c.req.json().catch(() => undefined as Record<string, unknown> | undefined);
    const message =
      raw && typeof raw === "object" && typeof raw.message === "string" ? raw.message : undefined;

    switch (group.joinPolicy) {
      case "open": {
        const member = addMember(db, groupId, actor.actor, "member");
        return c.json(member, 201);
      }
      case "request": {
        const request = requestToJoin(db, groupId, actor.actor, message);
        return c.json(request, 202);
      }
      default: {
        // `invite` (and any unknown policy): must redeem an invite (§5.6).
        throw AppError.forbidden({
          detail: "this group is invite-only; redeem an invite to join",
        });
      }
    }
  });

  // -- POST /api/groups/{groupId}/leave (§5.7, signed) ---------------------
  router.post("/leave", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });

    const membership = getMemberRow(db, groupId, actor.actor);
    if (!membership) throw AppError.notFound({ detail: "you are not a member of this group" });

    // The owner must transfer ownership before leaving (§5.7).
    if (membership.role === "owner") {
      throw AppError.conflict({
        detail: "the owner must transfer ownership before leaving",
      });
    }

    removeMember(db, groupId, actor.actor);
    return c.body(null, 204);
  });

  // -- GET /api/groups/{groupId}/members (§5.7, §7.2, optional auth) --------
  router.get("/members", optional, (c) => {
    const { db } = c.var;
    const groupId = requireParam(c, "groupId");

    const group = getGroupRow(db, groupId);
    if (!group) throw AppError.notFound({ detail: "no such group" });

    // Visible to members; public/discoverable groups MAY expose it publicly.
    const viewer = c.var.actor?.actor ?? null;
    if (!PUBLIC_TIERS.has(group.tier) && (viewer == null || !isMember(db, groupId, viewer))) {
      throw AppError.forbidden({ detail: "the member list is visible to members only" });
    }

    const cursor = c.req.query("cursor") ?? null;
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

    // P6 hook: membership-visibility hiding (§6) is applied inside
    // listMembersPage once a profile/visibility store exists; all members are
    // listed for now.
    const page = listMembersPage(db, groupId, limit, cursor);
    return c.json({ items: page.items, page: { nextCursor: page.nextCursor } });
  });

  // -- PATCH /api/groups/{groupId}/members/{userRef} (§5.7, signed) ---------
  router.patch("/members/:userRef", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const target = decodeUserRef(requireParam(c, "userRef"));

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const role = raw && typeof raw === "object" ? (raw as { role?: unknown }).role : undefined;
    if (typeof role !== "string" || role.length === 0) {
      throw AppError.badRequest({ detail: "`role` is required and must be a non-empty string" });
    }

    const groupRow = getGroupRow(db, groupId);
    if (!groupRow) throw AppError.notFound({ detail: "no such group" });

    // Caller must satisfy group `manage`.
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group's members" });
    }

    const targetRow = getMemberRow(db, groupId, target);
    if (!targetRow) throw AppError.notFound({ detail: "no such member" });

    // Transferring `owner` is owner-only and demotes the current owner to admin
    // (single-owner invariant).
    if (role === "owner") {
      if (getMembership(db, groupId, actor.actor)?.role !== "owner") {
        throw AppError.forbidden({
          detail: "only the current owner may transfer ownership",
        });
      }
      if (targetRow.role === "owner") {
        // Target is already the owner — nothing to transfer.
        return c.json(rowToMember(targetRow), 200);
      }
      return c.json(transferOwnership(db, groupId, target), 200);
    }

    // Demoting the current owner via a non-`owner` role change would leave the
    // group ownerless — reject (ownership leaves only via an owner transfer).
    if (targetRow.role === "owner") {
      throw AppError.forbidden({
        detail: "the owner's role can only change by transferring ownership to another member",
      });
    }

    // The assigned role must be known: canonical or in the group's `roles`.
    const group = rowToGroup(groupRow);
    const knownRoles = new Set<string>([
      ...CANONICAL_ROLES,
      ...(group.roles ?? []).map((r) => r.name),
    ]);
    if (!knownRoles.has(role)) {
      throw AppError.badRequest({ detail: `unknown role: ${role}` });
    }

    // Subset (self-protect) rule (§5.7): the caller must hold every permission
    // held by both the member's current role and the role being assigned.
    const callerRole = getMembership(db, groupId, actor.actor)?.role ?? "";
    if (!roleHoldsAll(callerRole, targetRow.role, group)) {
      throw AppError.forbidden({
        detail: "you may not change a member more privileged than you",
      });
    }
    if (!roleHoldsAll(callerRole, role, group)) {
      throw AppError.forbidden({
        detail: "you may not assign a role more privileged than your own",
      });
    }

    const updated = setMemberRole(db, groupId, target, role);
    return c.json(updated, 200);
  });

  // -- PATCH /api/groups/{groupId}/members/{userRef}/display-name (signed) --
  // Per-group display name (Overboard "Per-group display name"). A member may
  // set/clear their OWN nickname with no special permission; setting ANOTHER
  // member's nickname requires the `members.set-nickname` action AND obeys the
  // subset/self-protect rule (§5.7) — a caller may only rename a target whose
  // powers are a subset of the caller's; the owner is protected.
  router.patch("/members/:userRef/display-name", signed, async (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const target = decodeUserRef(requireParam(c, "userRef"));

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    // `displayNameOverride`: a non-empty string sets it; null/absent/empty clears it.
    const value =
      raw && typeof raw === "object"
        ? (raw as { displayNameOverride?: unknown }).displayNameOverride
        : undefined;
    let nickname: string | null;
    if (value == null || value === "") {
      nickname = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        nickname = null;
      } else if (trimmed.length > MAX_DISPLAY_NAME_OVERRIDE) {
        throw AppError.badRequest({
          detail: `displayNameOverride must be ${MAX_DISPLAY_NAME_OVERRIDE} characters or fewer`,
        });
      } else {
        nickname = trimmed;
      }
    } else {
      throw AppError.badRequest({
        detail: "`displayNameOverride` must be a string, or null/empty to clear",
      });
    }

    const groupRow = getGroupRow(db, groupId);
    if (!groupRow) throw AppError.notFound({ detail: "no such group" });

    const targetRow = getMemberRow(db, groupId, target);
    if (!targetRow) throw AppError.notFound({ detail: "no such member" });

    // Setting one's OWN nickname needs no permission; setting another's requires
    // the `members.set-nickname` action plus the subset/self-protect rule.
    if (target !== actor.actor) {
      if (!canActor(db, "members.set-nickname", groupId, actor.actor)) {
        throw AppError.forbidden({ detail: "you may not set other members' nicknames" });
      }
      // The owner is protected; a caller may only rename a target whose powers
      // are a subset of theirs (mirrors kick / role-change).
      const callerRole = getMembership(db, groupId, actor.actor)?.role ?? "";
      if (!roleHoldsAll(callerRole, targetRow.role, rowToGroup(groupRow))) {
        throw AppError.forbidden({
          detail: "you may not rename a member more privileged than you",
        });
      }
    } else if (!isMember(db, groupId, actor.actor)) {
      // Setting your own nickname still requires you to be a member of the group.
      throw AppError.forbidden({ detail: "you are not a member of this group" });
    }

    const updated = setMemberDisplayName(db, groupId, target, nickname);
    fanOutMemberUpdated(hub, db, groupId, updated);
    return c.json(updated, 200);
  });

  // -- DELETE /api/groups/{groupId}/members/{userRef} (§5.7, signed) --------
  router.delete("/members/:userRef", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const target = decodeUserRef(requireParam(c, "userRef"));

    const groupRow = getGroupRow(db, groupId);
    if (!groupRow) throw AppError.notFound({ detail: "no such group" });

    // Caller must satisfy group `moderate`.
    if (!canActor(db, "moderate", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not moderate this group" });
    }

    const targetRow = getMemberRow(db, groupId, target);
    if (!targetRow) throw AppError.notFound({ detail: "no such member" });

    // The owner can never be kicked.
    if (targetRow.role === "owner") {
      throw AppError.forbidden({ detail: "the owner cannot be removed" });
    }

    // Subset (self-protect) rule (§5.7): the caller must hold every permission
    // the target holds, otherwise they may not remove them.
    const callerRole = getMembership(db, groupId, actor.actor)?.role ?? "";
    if (!roleHoldsAll(callerRole, targetRow.role, rowToGroup(groupRow))) {
      throw AppError.forbidden({
        detail: "you may not remove a member more privileged than you",
      });
    }

    removeMember(db, groupId, target);
    return c.body(null, 204);
  });

  // -- GET /api/groups/{groupId}/requests (§5.7, signed; manage/moderate) --
  router.get("/requests", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    if (
      !canActor(db, "manage", groupId, actor.actor) &&
      !canActor(db, "moderate", groupId, actor.actor)
    ) {
      throw AppError.forbidden({ detail: "you may not view this group's join requests" });
    }

    return c.json({ items: listPendingJoinRequests(db, groupId) });
  });

  // -- POST .../requests/{requestId}/approve (§5.7, signed; manage/moderate) -
  router.post("/requests/:requestId/approve", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const requestId = requireParam(c, "requestId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    if (
      !canActor(db, "manage", groupId, actor.actor) &&
      !canActor(db, "moderate", groupId, actor.actor)
    ) {
      throw AppError.forbidden({ detail: "you may not manage this group's join requests" });
    }

    const row = getJoinRequestRow(db, requestId);
    if (!row || row.groupId !== groupId || row.state !== "pending") {
      throw AppError.notFound({ detail: "no such pending join request" });
    }

    return c.json(approveJoinRequest(db, row), 200);
  });

  // -- POST .../requests/{requestId}/deny (§5.7, signed; manage/moderate) ---
  router.post("/requests/:requestId/deny", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const requestId = requireParam(c, "requestId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    if (
      !canActor(db, "manage", groupId, actor.actor) &&
      !canActor(db, "moderate", groupId, actor.actor)
    ) {
      throw AppError.forbidden({ detail: "you may not manage this group's join requests" });
    }

    const row = getJoinRequestRow(db, requestId);
    if (!row || row.groupId !== groupId || row.state !== "pending") {
      throw AppError.notFound({ detail: "no such pending join request" });
    }

    denyJoinRequest(db, requestId);
    return c.body(null, 204);
  });

  return router;
}
