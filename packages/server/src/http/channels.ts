/**
 * `/api/groups/:groupId/channels` router — channel CRUD + tier enforcement
 * (spec §5.5) over the canonical `Channel` object (§5.2). Mounted under the
 * groups router so every route is group-scoped via the `:groupId` param.
 *
 *  - `GET /` (optional auth): list channels **visible to the caller**, honoring
 *    each channel's per-channel `view` override (§5.2.1) — not just tier +
 *    membership. → `{ items: [Channel] }`.
 *  - `POST /` (signed): caller must satisfy the group's `manage` action; `type`
 *    is REQUIRED + immutable. → 201 the created `Channel`.
 *  - `GET /:channelId` (optional auth): the §11.3 read gate — group tier,
 *    channel tier and any `view` override; a missing group → 404, and a channel
 *    that is missing or unreadable → the same 404 ("hidden channels answer as
 *    missing").
 *  - `PATCH /:channelId` (signed): the same read gate (404), then group
 *    `manage` (403); partial update; `type` cannot change (attempts are
 *    rejected 400). → 200.
 *  - `DELETE /:channelId` (signed): the same read gate (404), then group
 *    `manage` (403) → 204.
 *
 * Every route naming a channel resolves it through
 * {@link requireReadableChannel} (`channel-access.ts`), the gate messaging, WS
 * and follows also use, so this router cannot drift from them; a `403` is only
 * for a caller who can read the channel but lacks `manage`. The channel-join
 * alias is the exception (§8.2): it answers as a group join. Authorization
 * (group `manage`) delegates to `provider/permissions.ts`.
 *
 * The listing (`GET /`) answers `403` for a group the caller cannot read,
 * mirroring `GET /api/groups/{id}`: §11.3 does not say what a listing that
 * names only an unreadable group answers (open spec question).
 */
import { ChannelCreateRequestSchema, ChannelUpdateRequestSchema } from "@forumall/shared";
import { type Context, Hono } from "hono";

import { revalidateChannelSubscriptions } from "../provider/access-revocation.ts";
import {
  canViewChannel,
  createChannel,
  deleteChannel,
  getChannelRow,
  listChannelRows,
  rowToChannel,
  updateChannel,
} from "../provider/channels.ts";
import { getGroupRow } from "../provider/groups.ts";
import { addMember, getMemberRow, requestToJoin, rowToMember } from "../provider/membership.ts";
import { canActor } from "../provider/permissions.ts";
import { effectiveJoinPolicy, tierReadableBy } from "../provider/tiers.ts";
import { requireReadableChannel } from "./channel-access.ts";
import { AppError } from "./errors.ts";
import { createMessagesRouter } from "./messages.ts";
import { optionalSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/**
 * Read a path param that is guaranteed present by the mounted route (e.g.
 * `:groupId` from the parent groups router). Hono types params per the router
 * instance, so a param inherited from a parent mount is typed `string |
 * undefined`; this narrows it. A truly absent param can never reach a handler
 * whose pattern requires it, so the empty-string fallback is unreachable.
 */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

export function createChannelsRouter() {
  // `mergeRouter`-style mount: parent supplies `/api/groups/:groupId/channels`.
  const router = new Hono<AppBindings>();
  const signed = requireSignature();
  const optional = optionalSignature();

  // -- GET /api/groups/{groupId}/channels (§5.5, optional auth) ------------
  router.get("/", optional, (c) => {
    const { db } = c.var;
    const groupId = requireParam(c, "groupId");

    const group = getGroupRow(db, groupId);
    if (!group) throw AppError.notFound({ detail: "no such group" });

    // The group must be readable first: a private/group group is only readable
    // by a member (mirrors GET /api/groups/{id}). 403 there means no channels.
    const actor = c.var.actor?.actor ?? null;
    if (!tierReadableBy(db, groupId, group.tier, actor)) {
      throw AppError.forbidden({ detail: "this group is private" });
    }

    // Per-channel read gate (§5.2.1 `view`, §11 group/channel tier), not just
    // tier + membership — see canViewChannel's doc comment.
    const items = listChannelRows(db, groupId)
      .filter((row) => canViewChannel(db, row, actor))
      .map(rowToChannel);
    return c.json({ items });
  });

  // -- POST /api/groups/{groupId}/channels (§5.5, signed; `manage`) --------
  router.post("/", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable: middleware sets it
    const groupId = requireParam(c, "groupId");

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = ChannelCreateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid channel create request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    // 404 before 403: an unknown group is not found, regardless of caller.
    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group" });
    }

    const channel = createChannel(db, groupId, parsed.data);
    return c.json(channel, 201);
  });

  // -- GET /api/groups/{groupId}/channels/{channelId} (§5.5, optional) -----
  router.get("/:channelId", optional, (c) => {
    const { db } = c.var;
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");

    // Read gate (§11.3): an unreadable channel answers exactly as a missing one.
    const row = requireReadableChannel(db, groupId, channelId, c.var.actor?.actor ?? null);
    return c.json(rowToChannel(row));
  });

  // -- PATCH /api/groups/{groupId}/channels/{channelId} (§5.5, signed) -----
  router.patch("/:channelId", signed, async (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });

    // `type` is immutable (§5.2): reject any attempt to change it up front, even
    // before schema validation (the update schema has no `type` field).
    if (typeof raw === "object" && raw !== null && "type" in raw) {
      throw AppError.badRequest({ detail: "channel `type` is immutable and cannot be changed" });
    }

    const parsed = ChannelUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid channel update request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    // Read access before `manage` (§11.3): a manager left out of `view` cannot
    // see the channel, so cannot change it; a non-reader cannot learn it exists.
    requireReadableChannel(db, groupId, channelId, actor.actor);
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group" });
    }

    const updated = updateChannel(db, channelId, parsed.data);
    if (!updated) throw AppError.notFound({ detail: "no such channel" }); // raced delete
    // A tier or `permissions.view` change can revoke read access for live subscribers.
    revalidateChannelSubscriptions(db, hub, [channelId]);
    return c.json(updated);
  });

  // -- DELETE /api/groups/{groupId}/channels/{channelId} (§5.5, signed) ----
  router.delete("/:channelId", signed, (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");

    // Read access before `manage` (§11.3): a manager left out of `view` cannot
    // see the channel, so cannot change it; a non-reader cannot learn it exists.
    requireReadableChannel(db, groupId, channelId, actor.actor);
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group" });
    }

    deleteChannel(db, channelId);
    // Every live subscription to the deleted channel ends (with the notice).
    revalidateChannelSubscriptions(db, hub, [channelId]);
    return c.body(null, 204);
  });

  // -- POST /api/groups/{groupId}/channels/{channelId}/join (§8.2, signed) --
  //
  // The endpoint a (typically REMOTE, §8.5 step 1) user calls to become a member
  // before subscribing for live events. In this implementation channel
  // membership IS group membership + channel tier: there is no per-channel
  // member list, so joining a channel joins its PARENT GROUP, honoring the
  // group's `joinPolicy` exactly like `POST /api/groups/{groupId}/join` (§5.7):
  //   - `open`    → immediate `member` (201, returns the `Member`);
  //   - `request` → pending `JoinRequest` (202, idempotent while pending);
  //   - `invite`  → 403 (must redeem an invite, §5.6).
  // A remote user can call this because remote user-signed requests now verify
  // (§4.6); subscribe-time tier/visibility (§7.1) then gates real-time access.
  router.post("/:channelId/join", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable: middleware sets it
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    const channel = getChannelRow(db, channelId);
    if (!channel || channel.groupId !== groupId) {
      throw AppError.notFound({ detail: "no such channel" });
    }
    const group = getGroupRow(db, groupId);
    if (!group) throw AppError.notFound({ detail: "no such group" }); // raced delete

    // Already a member → idempotent return of their group membership (200).
    const existing = getMemberRow(db, groupId, actor.actor);
    if (existing) return c.json(rowToMember(existing), 200);

    // The body is optional; only the `request` policy reads `{ message }`.
    const raw = await c.req.json().catch(() => undefined as Record<string, unknown> | undefined);
    const message =
      raw && typeof raw === "object" && typeof raw.message === "string" ? raw.message : undefined;

    switch (effectiveJoinPolicy(group.tier, group.joinPolicy)) {
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

  // -- Message history nested under the channel (§7.2). Mounted here so
  // `:groupId` + `:channelId` are in scope via merged request params.
  router.route("/:channelId/messages", createMessagesRouter());

  return router;
}
