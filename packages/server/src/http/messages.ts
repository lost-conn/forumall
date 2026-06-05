/**
 * `/api/groups/:groupId/channels/:channelId/messages` router — paged message
 * history reads (spec §5.3, §7.2). Mounted under the channels router so both
 * `:groupId` and `:channelId` are in scope via merged request params.
 *
 *  - `GET /` (optional auth): read a page of the channel timeline. Authorized
 *    via {@link channelVisibleTo} — a public/discoverable channel is readable by
 *    anyone able to read the group; a private/group channel only by a member
 *    (else 403). A missing group/channel → 404. Query: `cursor` (opaque),
 *    `direction` (`backward` default | `forward`), `limit`. → `{ items, page:
 *    { nextCursor, prevCursor } }` per §7.2, validated against
 *    `MessagesPageSchema`.
 *
 * This card is storage + REST reads only; `message.create`/fan-out, edits,
 * deletes, and reactions are later WS cards that reuse `provider/messages.ts`
 * (the seq/cursor contract documented there).
 */
import { MessagesPageSchema } from "@forumall/shared";
import { type Context, Hono } from "hono";

import { channelVisibleTo, getChannelRow } from "../provider/channels.ts";
import { getGroupRow } from "../provider/groups.ts";
import { listMessages } from "../provider/messages.ts";
import { AppError } from "./errors.ts";
import { optionalSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/**
 * Read a path param guaranteed present by the mounted route (`:groupId` /
 * `:channelId` from the parent routers). Mirrors the channels router helper; the
 * empty-string fallback is unreachable for a route whose pattern requires it.
 */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

export function createMessagesRouter() {
  // Parent supplies `/api/groups/:groupId/channels/:channelId/messages`.
  const router = new Hono<AppBindings>();
  const optional = optionalSignature();

  // -- GET .../messages (§7.2, optional auth) ------------------------------
  router.get("/", optional, (c) => {
    const { db } = c.var;
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");

    // 404 before 403: an unknown group/channel is not found, regardless of caller.
    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    const channel = getChannelRow(db, channelId);
    if (!channel || channel.groupId !== groupId) {
      throw AppError.notFound({ detail: "no such channel" });
    }

    // Tier rules mirror the channel read: private/group channel → members only.
    const actor = c.var.actor?.actor ?? null;
    if (!channelVisibleTo(db, groupId, channel.tier, actor)) {
      throw AppError.forbidden({ detail: "this channel is private" });
    }

    const cursor = c.req.query("cursor") ?? null;
    const directionRaw = c.req.query("direction");
    const direction = directionRaw === "forward" ? "forward" : "backward";
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

    const page = listMessages(db, channelId, {
      cursor,
      direction,
      ...(limit !== undefined ? { limit } : {}),
    });

    // Validate the response shape (§7.2 `messages-page`) before returning.
    return c.json(MessagesPageSchema.parse(page));
  });

  return router;
}
