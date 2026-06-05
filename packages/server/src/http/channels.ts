/**
 * `/api/groups/:groupId/channels` router — channel CRUD + tier enforcement
 * (spec §5.5) over the canonical `Channel` object (§5.2). Mounted under the
 * groups router so every route is group-scoped via the `:groupId` param.
 *
 *  - `GET /` (optional auth): list channels **visible to the caller** — a
 *    public/discoverable channel is visible to anyone able to read the group; a
 *    private/group channel only to a group member. → `{ items: [Channel] }`.
 *  - `POST /` (signed): caller must satisfy the group's `manage` action; `type`
 *    is REQUIRED + immutable. → 201 the created `Channel`.
 *  - `GET /:channelId` (optional auth): tier rules mirror `GET /api/groups/{id}`
 *    — public/discoverable readable by anyone, private/group requires
 *    membership → 403; missing channel/group → 404.
 *  - `PATCH /:channelId` (signed): group `manage`; partial update; `type` cannot
 *    change (attempts are rejected 400). → 200.
 *  - `DELETE /:channelId` (signed): group `manage` → 204.
 *
 * The parent group must be readable for any channel access: the group-level tier
 * gate (public/discoverable → anyone; private/group → member) is applied first,
 * mirroring `GET /api/groups/{id}`, then the channel's own tier is checked.
 * Authorization (group `manage`) delegates to `provider/permissions.ts`;
 * channel-visibility delegates to {@link channelVisibleTo} so messaging /
 * subscription cards share one rule.
 */
import { ChannelCreateRequestSchema, ChannelUpdateRequestSchema } from "@forumall/shared";
import { type Context, Hono } from "hono";

import {
  channelVisibleTo,
  createChannel,
  deleteChannel,
  getChannelRow,
  listChannelRows,
  rowToChannel,
  updateChannel,
} from "../provider/channels.ts";
import { getGroupRow } from "../provider/groups.ts";
import { addMember, getMemberRow, requestToJoin, rowToMember } from "../provider/membership.ts";
import { canActor, isMember } from "../provider/permissions.ts";
import { AppError } from "./errors.ts";
import { createMessagesRouter } from "./messages.ts";
import { optionalSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Tiers that are publicly readable without authentication (§5.5). */
const PUBLIC_TIERS = new Set(["public", "discoverable"]);

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
    if (!PUBLIC_TIERS.has(group.tier) && (actor == null || !isMember(db, groupId, actor))) {
      throw AppError.forbidden({ detail: "this group is private" });
    }

    const items = listChannelRows(db, groupId)
      .filter((row) => channelVisibleTo(db, groupId, row.tier, actor))
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

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    const row = getChannelRow(db, channelId);
    if (!row || row.groupId !== groupId) {
      throw AppError.notFound({ detail: "no such channel" });
    }

    // Tier rules mirror GET /api/groups/{id}: missing → 404 (above), private +
    // non-member → 403.
    const actor = c.var.actor?.actor ?? null;
    if (!channelVisibleTo(db, groupId, row.tier, actor)) {
      throw AppError.forbidden({ detail: "this channel is private" });
    }

    return c.json(rowToChannel(row));
  });

  // -- PATCH /api/groups/{groupId}/channels/{channelId} (§5.5, signed) -----
  router.patch("/:channelId", signed, async (c) => {
    const { db } = c.var;
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

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    const existing = getChannelRow(db, channelId);
    if (!existing || existing.groupId !== groupId) {
      throw AppError.notFound({ detail: "no such channel" });
    }
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group" });
    }

    const updated = updateChannel(db, channelId, parsed.data);
    if (!updated) throw AppError.notFound({ detail: "no such channel" }); // raced delete
    return c.json(updated);
  });

  // -- DELETE /api/groups/{groupId}/channels/{channelId} (§5.5, signed) ----
  router.delete("/:channelId", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    const existing = getChannelRow(db, channelId);
    if (!existing || existing.groupId !== groupId) {
      throw AppError.notFound({ detail: "no such channel" });
    }
    if (!canActor(db, "manage", groupId, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group" });
    }

    deleteChannel(db, channelId);
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

  // -- Message history nested under the channel (§7.2). Mounted here so
  // `:groupId` + `:channelId` are in scope via merged request params.
  router.route("/:channelId/messages", createMessagesRouter());

  return router;
}
