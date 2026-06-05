/**
 * `/api/groups` router — group CRUD (spec §5.5) over the canonical `Group`
 * object (§5.2).
 *
 *  - `POST /` (signed): create a group; the caller becomes `owner`. → 201.
 *  - `GET /:id` (optional auth): public/discoverable readable by anyone; private/
 *    group readable only by an authenticated member. 404 missing, 403 private.
 *  - `PATCH /:id` (signed): caller must satisfy the group's `manage` action. → 200.
 *  - `DELETE /:id` (signed): owner only. → 204.
 *
 * Authorization decisions delegate to `provider/permissions.ts` so every card
 * shares one resolver; storage/shape mapping lives in `provider/groups.ts`.
 */
import { type Group, GroupCreateRequestSchema, GroupUpdateRequestSchema } from "@forumall/shared";
import { Hono } from "hono";

import {
  createGroup,
  deleteGroup,
  getGroupRow,
  rowToGroup,
  updateGroup,
} from "../provider/groups.ts";
import { canActor, isMember } from "../provider/permissions.ts";
import { createChannelsRouter } from "./channels.ts";
import { AppError } from "./errors.ts";
import { optionalSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Tiers that are publicly readable without authentication (§5.5). */
const PUBLIC_TIERS = new Set(["public", "discoverable"]);

export function createGroupsRouter() {
  const router = new Hono<AppBindings>();
  // Reuse single middleware instances so signed routes share a nonce store.
  const signed = requireSignature();
  const optional = optionalSignature();

  // -- POST /api/groups (§5.5) ---------------------------------------------
  router.post("/", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable: middleware sets it

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = GroupCreateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid group create request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    const group: Group = createGroup(db, actor.actor, parsed.data);
    return c.json(group, 201);
  });

  // -- GET /api/groups/{id} (§5.5, optional auth) --------------------------
  router.get("/:id", optional, (c) => {
    const { db } = c.var;
    const id = c.req.param("id");

    const row = getGroupRow(db, id);
    if (!row) throw AppError.notFound({ detail: "no such group" });

    // Public/discoverable: anyone may read. Private/group: an authenticated
    // member only — else 403 (§5.5). Follow the spec: missing → 404 (above),
    // private + non-member → 403.
    if (!PUBLIC_TIERS.has(row.tier)) {
      const actor = c.var.actor;
      if (!actor || !isMember(db, id, actor.actor)) {
        throw AppError.forbidden({ detail: "this group is private" });
      }
    }

    return c.json(rowToGroup(row));
  });

  // -- PATCH /api/groups/{id} (§5.5, signed; requires `manage`) -------------
  router.patch("/:id", signed, async (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const id = c.req.param("id");

    const raw = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const parsed = GroupUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest({
        detail: "invalid group update request",
        extensions: { errors: parsed.error.flatten() },
      });
    }

    // 404 before 403: an unknown group is not found, regardless of caller.
    if (!getGroupRow(db, id)) throw AppError.notFound({ detail: "no such group" });
    if (!canActor(db, "manage", id, actor.actor)) {
      throw AppError.forbidden({ detail: "you may not manage this group" });
    }

    const updated = updateGroup(db, id, parsed.data);
    if (!updated) throw AppError.notFound({ detail: "no such group" }); // raced delete
    return c.json(updated);
  });

  // -- DELETE /api/groups/{id} (§5.5, signed; owner only) ------------------
  router.delete("/:id", signed, (c) => {
    const { db } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized(); // unreachable
    const id = c.req.param("id");

    const row = getGroupRow(db, id);
    if (!row) throw AppError.notFound({ detail: "no such group" });
    if (row.owner !== actor.actor) {
      throw AppError.forbidden({ detail: "only the group owner may delete it" });
    }

    deleteGroup(db, id);
    return c.body(null, 204);
  });

  // -- Channel CRUD nested under the group (§5.5) --------------------------
  // Mounted here so `:groupId` is in scope; the channel router reads it via the
  // merged request params.
  router.route("/:groupId/channels", createChannelsRouter());

  return router;
}
