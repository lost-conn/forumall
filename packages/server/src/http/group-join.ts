/**
 * Joining a group by its `joinPolicy` (spec §5.7), shared by
 * `POST /api/groups/{groupId}/join` and its channel alias
 * `POST /api/groups/{groupId}/channels/{channelId}/join` (§8.2), which answers
 * exactly as a group join. The routes resolve the group (and channel) first;
 * this runs the join itself:
 *
 *  1. The body is optional: an absent or zero-length body is fine; any other
 *     body must be JSON on every join, else `400` — before any answer the join
 *     policy gives (an `invite` group sent `abc` gets `400`, not `403`).
 *  2. An existing member gets their `Member` (`200`, idempotent).
 *  3. By the effective join policy: `open` → a new `member` (`201`);
 *     `request` → the body is checked against `join-create-request` (`400`;
 *     a repeat while a request is pending too) and a pending `JoinRequest` is
 *     returned (`202`, the existing one unchanged while pending); `invite` (or
 *     any unknown policy) → `403`. Only `request` reads the body's `message`.
 */
import { JoinCreateRequestSchema } from "@forumall/shared";
import type { Context } from "hono";

import type { GroupRow } from "../db/schema.ts";
import { addMember, getMemberRow, requestToJoin, rowToMember } from "../provider/membership.ts";
import { effectiveJoinPolicy } from "../provider/tiers.ts";
import { AppError, parseRequestBody } from "./errors.ts";
import { parseJsonText } from "./optional-body.ts";
import type { AppBindings } from "./types.ts";

/** How a join body is named in its `400` details. */
const JOIN_BODY = "join request body";

/** Join `group` as the signed caller; see the module doc for the answers. */
export async function joinGroup(c: Context<AppBindings>, group: GroupRow): Promise<Response> {
  const { db } = c.var;
  const actor = c.var.actor;
  if (!actor) throw AppError.unauthorized(); // unreachable: the routes require a signature

  const text = await c.req.text();
  const raw = text.length === 0 ? undefined : parseJsonText(text, JOIN_BODY);

  const existing = getMemberRow(db, group.id, actor.actor);
  if (existing) return c.json(rowToMember(existing), 200);

  switch (effectiveJoinPolicy(group.tier, group.joinPolicy)) {
    case "open": {
      const member = addMember(db, group.id, actor.actor, "member");
      return c.json(member, 201);
    }
    case "request": {
      const body =
        raw === undefined ? {} : parseRequestBody(JoinCreateRequestSchema, raw, JOIN_BODY);
      const request = requestToJoin(db, group.id, actor.actor, body.message);
      return c.json(request, 202);
    }
    default: {
      throw AppError.forbidden({
        detail: "this group is invite-only; redeem an invite to join",
      });
    }
  }
}
