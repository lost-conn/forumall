/**
 * Invites / join links + guest provisioning (spec §5.6, §4.8).
 *
 * Two routers:
 *
 *  - {@link createGroupInvitesRouter} is mounted **under the group router** so
 *    `:groupId` is in scope; every route requires the group `manage` role:
 *      - `POST   /invites`            (signed): mint an invite → 201 `Invite`
 *                                      with its `token` (+ a shareable `link`).
 *                                      The only response that carries the
 *                                      token: only its digest is stored.
 *      - `GET    /invites`            (signed): list the group's invites
 *                                      (without tokens).
 *      - `DELETE /invites/{inviteId}` (signed): revoke → 204.
 *
 *  - {@link createInvitesRouter} is mounted at **`/api/invites`** and handles
 *    redemption:
 *      - `POST /invites/{token}/redeem` (signed): join the group/channel as an
 *        existing account → 200 `{ groupId, channelId?, role }`. The invite is
 *        checked first (404 unknown/expired, 409 exhausted), whoever the
 *        caller is; an existing member then gets their current role and
 *        consumes no use. A since-deleted `channelId` is omitted. A guest
 *        redeeming another group's invite → 403 (§4.8, `guest-binding.ts`);
 *        an invite whose custom role the group no longer defines → 400.
 *      - `POST /invites/{token}/guest`  (**unsigned**): provision a guest
 *        account (§4.8) + bind its first device key → 201. The guest's role
 *        is always `guest`, whatever the invite's `role`.
 *
 * Tokens appear in these paths, so nothing here logs a request path or a
 * token.
 *
 * Authorization decisions delegate to `provider/permissions.ts` (`manage`);
 * storage lives in `provider/invites.ts`; membership mutation reuses
 * `provider/membership.ts`; guest accounts + the `UserProfile` builder live in
 * `provider/guests.ts`.
 */
import {
  GuestCreateRequestSchema,
  InviteCreateRequestSchema,
  type InviteCreateResponse,
} from "@forumall/shared";
import { type Context, Hono } from "hono";

import type { InviteRow } from "../db/schema.ts";
import { getChannelRow } from "../provider/channels.ts";
import { isValidEd25519PublicKey, registerDeviceKey } from "../provider/device-keys.ts";
import { getGroupRow, rowToGroup } from "../provider/groups.ts";
import { buildUserProfile, createGuestUser } from "../provider/guests.ts";
import {
  consumeInviteUse,
  createInvite,
  deleteInvite,
  getInviteByToken,
  getInviteRow,
  isInviteExhausted,
  isInviteExpired,
  listInvites,
  rowToInvite,
} from "../provider/invites.ts";
import { addMember, getMemberRow } from "../provider/membership.ts";
import { canActor, getMembership, isKnownRole, roleHoldsAll } from "../provider/permissions.ts";
import { AppError } from "./errors.ts";
import { refuseGuestOutsideItsGroup } from "./guest-binding.ts";
import { optionalActorOrProviderSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Read a path param guaranteed present by the mounted route. */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/** Parse an optional RFC 3339 `expiresAt` string to epoch millis, or 400. */
function parseExpiresAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw AppError.badRequest({ detail: "`expiresAt` must be a valid RFC 3339 timestamp" });
  }
  return millis;
}

/** The shareable join-link convention (§5.6): `https://{domain}/invite/{token}`. */
function inviteLink(domain: string, token: string): string {
  return `https://${domain}/invite/${token}`;
}

/**
 * The invite's `channelId` for a redemption answer, when it has one and that
 * channel still exists in the invite's group (§5.6: a since-deleted channel is
 * omitted, and the redemption still succeeds).
 */
function liveChannelId(db: AppBindings["Variables"]["db"], invite: InviteRow): string | undefined {
  if (invite.channelId == null) return undefined;
  const channel = getChannelRow(db, invite.channelId);
  return channel && channel.groupId === invite.groupId ? channel.id : undefined;
}

/** The `{ groupId, channelId?, role }` body of a successful redemption (§5.6). */
function redeemBody(db: AppBindings["Variables"]["db"], invite: InviteRow, role: string) {
  const channelId = liveChannelId(db, invite);
  return { groupId: invite.groupId, ...(channelId !== undefined ? { channelId } : {}), role };
}

/**
 * Group-scoped invite management (§5.6). Mounted under the group router; all
 * routes require the group `manage` role.
 */
export function createGroupInvitesRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- POST /api/groups/{groupId}/invites (§5.6, signed; manage) -----------
  router.post("/", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable: middleware sets it
    const groupId = requireParam(c, "groupId");

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = InviteCreateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid invite create request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    // 404 before 403: an unknown group is not found, regardless of caller.
    const groupRow = getGroupRow(db, groupId);
    if (!groupRow) throw AppError.notFound({ detail: "no such group" });
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group's invites" });
    }
    const group = rowToGroup(groupRow);

    // §5.6 field checks. `role` must exist in the group and is never `owner`
    // (ownership passes only by transfer, §5.7).
    const { role, channelId } = parsed.data;
    if (role !== undefined && (role === "owner" || !isKnownRole(role, group))) {
      throw AppError.badRequest({
        detail:
          role === "owner"
            ? "an invite cannot grant `owner`; ownership passes only by transfer"
            : `unknown role: ${role}`,
      });
    }
    if (channelId !== undefined && getChannelRow(db, channelId)?.groupId !== groupId) {
      throw AppError.badRequest({ detail: "`channelId` must name a channel of this group" });
    }
    // Subset rule (§5.7): the creator must hold every permission of the role
    // the invite grants through `/redeem` (`member` when absent).
    const creatorRole = getMembership(db, groupId, actor.actor)?.role ?? "";
    if (!roleHoldsAll(creatorRole, role ?? "member", group)) {
      throw AppError.forbidden({
        detail: "you may not create an invite granting a role more privileged than your own",
      });
    }

    const { row, token } = createInvite(db, groupId, actor.actor, {
      channelId,
      role,
      grantsGuest: parsed.data.grantsGuest,
      maxUses: parsed.data.maxUses,
      expiresAt: parseExpiresAt(parsed.data.expiresAt),
    });

    // The creation response is the only place the token appears (§5.6): the
    // provider keeps just its digest. The shareable link convention rides
    // alongside (the schema is passthrough, so the extra field is preserved).
    const invite: InviteCreateResponse = { ...rowToInvite(row), token };
    return c.json({ ...invite, link: inviteLink(c.var.config.domain, token) }, 201);
  });

  // -- GET /api/groups/{groupId}/invites (§5.6, signed; manage) ------------
  router.get("/", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not view this group's invites" });
    }

    return c.json({ items: listInvites(db, groupId) });
  });

  // -- DELETE /api/groups/{groupId}/invites/{inviteId} (§5.6, signed) ------
  router.delete("/:inviteId", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const inviteId = requireParam(c, "inviteId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group's invites" });
    }

    const row = getInviteRow(db, inviteId);
    if (!row || row.groupId !== groupId) {
      throw AppError.notFound({ detail: "no such invite" });
    }
    deleteInvite(db, inviteId);
    return c.body(null, 204);
  });

  return router;
}

/**
 * Top-level invite redemption (§5.6). Mounted at `/api/invites`.
 *
 * `redeem` is signed (existing account); `guest` is unsigned (the guest has no
 * key yet and supplies its first device key in the body).
 */
export function createInvitesRouter() {
  const router = new Hono<AppBindings>();
  const signed = requireSignature();

  // -- POST /api/invites/{token}/redeem (§5.6, signed) --------------------
  router.post("/:token/redeem", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const token = requireParam(c, "token");

    // The invite is checked first, whoever the caller is (§5.6): unknown or
    // expired → 404, exhausted → 409, even for an existing member.
    const invite = getInviteByToken(db, token);
    if (!invite || isInviteExpired(invite)) {
      throw AppError.notFound({ detail: "unknown or expired invite" });
    }
    // The group must still exist (a raced delete cascades invites, but guard).
    const groupRow = getGroupRow(db, invite.groupId);
    if (!groupRow) throw AppError.notFound({ detail: "unknown or expired invite" });
    if (isInviteExhausted(invite)) {
      throw AppError.conflict({ detail: "this invite has reached its maximum uses" });
    }

    // A valid invite redeemed by an existing member (the owner included):
    // their current role, unchanged, and no use consumed (§5.6).
    const existing = getMemberRow(db, invite.groupId, actor.actor);
    if (existing) return c.json(redeemBody(db, invite, existing.role), 200);

    // A guest is bound to the group it joined (§4.8): another group's invite
    // is refused (`403`, "provider/group policy forbids").
    refuseGuestOutsideItsGroup(db, actor);

    // The invite's role is re-validated against the group as it is NOW: a
    // custom role removed from the `roles` catalogue since the invite was
    // created is no longer one the invite may grant. The spec defines no
    // redeem-time answer for this, so it is refused with the same `400` an
    // invite naming an unknown role gets at creation (§5.6). Checked before a
    // use is consumed.
    if (!isKnownRole(invite.role, rowToGroup(groupRow))) {
      throw AppError.badRequest({
        detail: `this invite grants role \`${invite.role}\`, which the group no longer defines`,
      });
    }

    // Consume a use atomically, respecting maxUses → 409 if a concurrent
    // redemption took the last one since the check above (§5.6).
    if (consumeInviteUse(db, invite.id) === "exhausted") {
      throw AppError.conflict({ detail: "this invite has reached its maximum uses" });
    }

    addMember(db, invite.groupId, actor.actor, invite.role);
    return c.json(redeemBody(db, invite, invite.role), 200);
  });

  // -- POST /api/invites/{token}/guest (§5.6, §4.8, UNSIGNED) -------------
  // The guest has no key yet, so this endpoint is unauthenticated; it carries
  // the guest's first device key in the body and provisions a provider-local
  // guest account (§4.8). All subsequent requests are signed (§4.4).
  router.post("/:token/guest", optionalActorOrProviderSignature(), async (c) => {
    const { db, config } = c.var;
    const token = requireParam(c, "token");

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = GuestCreateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid guest create request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    // Algorithm must be Ed25519 (§4.3.3). The enum already rejects other values,
    // but the field is optional in the schema — be explicit.
    if (parsed.data.algorithm !== undefined && parsed.data.algorithm !== "Ed25519") {
      throw AppError.badRequest({ detail: "algorithm must be 'Ed25519'" });
    }
    if (!isValidEd25519PublicKey(parsed.data.public_key)) {
      throw AppError.badRequest({
        detail: "public_key must be base64-encoded 32-byte Ed25519 key material",
      });
    }

    const invite = getInviteByToken(db, token);
    if (!invite || isInviteExpired(invite)) {
      throw AppError.notFound({ detail: "unknown or expired invite" });
    }
    if (!getGroupRow(db, invite.groupId)) {
      throw AppError.notFound({ detail: "unknown or expired invite" });
    }

    // Guests require the invite to opt in (§4.8). Otherwise a full account is
    // required to redeem → 403.
    if (!invite.grantsGuest) {
      throw AppError.forbidden({ detail: "this invite does not grant guest access" });
    }

    // Consume a use atomically, respecting maxUses → 409 if exhausted (§5.6).
    if (consumeInviteUse(db, invite.id) === "exhausted") {
      throw AppError.conflict({ detail: "this invite has reached its maximum uses" });
    }

    // Provision the guest account, bind its device key, and add the membership.
    // A guest's role is always `guest`, whatever the invite's `role` (§4.8,
    // §5.6); the invite's channel plays no part, so a since-deleted one does
    // not block the join.
    const guestRole = "guest";
    const user = createGuestUser(db, {
      displayName: parsed.data.displayName,
      expiresAt: invite.expiresAt ?? undefined,
    });

    const keyRecord = registerDeviceKey(db, {
      handle: user.handle,
      publicKey: parsed.data.public_key,
      deviceName: parsed.data.device_name,
    });

    const actor = `${user.handle}@${config.domain}`;
    addMember(db, invite.groupId, actor, guestRole);

    const profile = buildUserProfile(db, config.domain, user.handle);

    return c.json(
      {
        actor,
        key_id: keyRecord.keyId,
        profile,
        groupId: invite.groupId,
        role: guestRole,
      },
      201,
    );
  });

  return router;
}
