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
import {
  MessageSchema,
  MessageUpdateRequestSchema,
  MessagesPageSchema,
  PagedResponseSchema,
  ReactionSchema,
  WsMessageDeletedSchema,
  WsMessageUpdatedSchema,
  WsReactionAddedSchema,
  WsReactionRemovedSchema,
  rfc3339Timestamp,
} from "@forumall/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";

import { canViewChannel, getChannelRow } from "../provider/channels.ts";
import { getGroupRow } from "../provider/groups.ts";
import { listMessages, tombstoneMessage, updateMessageContent } from "../provider/messages.ts";
import { addReaction, hasReaction, listReactions, removeReaction } from "../provider/reactions.ts";
import { AppError } from "./errors.ts";
import {
  authorizeMessageDelete,
  authorizeMessageEdit,
  authorizeReaction,
} from "./message-mutations.ts";
import { optionalSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Turn a {@link MutationError} status into the matching {@link AppError}. */
function toAppError(error: { code: string; message: string; status: number }): AppError {
  return error.status === 404
    ? AppError.notFound({ detail: error.message })
    : AppError.forbidden({ detail: error.message });
}

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
  const signed = requireSignature();

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

    // Read gate (§5.2.1): tier + membership, plus any per-channel `view` override.
    const actor = c.var.actor?.actor ?? null;
    if (!canViewChannel(db, channel, actor)) {
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

  // -- PATCH .../messages/:messageId (§7.1 edit, signed) -------------------
  // Author-only + edit window; returns the updated Message (with `editedAt`).
  // Fans out `message.updated` to WS subscribers via the shared hub.
  router.patch("/:messageId", signed, async (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");
    const messageId = requireParam(c, "messageId");

    const body = MessageUpdateRequestSchema.parse(await c.req.json());

    const outcome = authorizeMessageEdit(db, groupId, channelId, messageId, actor.actor);
    if (outcome.error) throw toAppError(outcome.error);

    const record = updateMessageContent(db, channelId, messageId, body.content);

    // Reach WS subscribers exactly as the WS path does (REST/WS parity).
    hub.publishToChannel(channelId, {
      type: "message.updated",
      data: WsMessageUpdatedSchema.shape.data.parse({
        groupId,
        channelId,
        cursor: record.cursor,
        message: record.message,
      }),
    });

    return c.json(MessageSchema.parse(record.message));
  });

  // -- DELETE .../messages/:messageId (§7.1 tombstone, signed) ------------
  // Author OR a `moderate` member; soft-delete → 204. Fans out
  // `message.deleted` to WS subscribers via the shared hub.
  router.delete("/:messageId", signed, (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");
    const messageId = requireParam(c, "messageId");

    const outcome = authorizeMessageDelete(db, groupId, channelId, messageId, actor.actor);
    if (outcome.error) throw toAppError(outcome.error);

    const record = tombstoneMessage(db, channelId, messageId);
    const deletedAt = record.message.deletedAt ?? rfc3339Timestamp();

    hub.publishToChannel(channelId, {
      type: "message.deleted",
      data: WsMessageDeletedSchema.shape.data.parse({
        groupId,
        channelId,
        messageId,
        cursor: record.cursor,
        deletedAt,
      }),
    });

    return c.body(null, 204);
  });

  // -- GET .../messages/:messageId/reactions (§7.1, optional auth) ----------
  // Paginated list of `Reaction` objects (history / late-joiners). Channel-
  // visibility gated exactly like the message-history read: a private channel's
  // reactions are readable only by a member (else 403); unknown group/channel/
  // message → 404.
  router.get("/:messageId/reactions", optional, (c) => {
    const { db } = c.var;
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");
    const messageId = requireParam(c, "messageId");

    if (!getGroupRow(db, groupId)) throw AppError.notFound({ detail: "no such group" });
    const channel = getChannelRow(db, channelId);
    if (!channel || channel.groupId !== groupId) {
      throw AppError.notFound({ detail: "no such channel" });
    }
    const actor = c.var.actor?.actor ?? null;
    if (!canViewChannel(db, channel, actor)) {
      throw AppError.forbidden({ detail: "this channel is private" });
    }

    const cursor = c.req.query("cursor") ?? null;
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

    const page = listReactions(db, messageId, {
      cursor,
      ...(limit !== undefined ? { limit } : {}),
    });
    // Validate against the generic `PagedResponse` shape (items are Reactions).
    return c.json(
      PagedResponseSchema.parse({
        items: page.items.map((r) => ReactionSchema.parse(r)),
        page: page.page,
      }),
    );
  });

  // -- PUT .../messages/:messageId/reactions/:key (§7.1, signed) ------------
  // Add your reaction (optional body `{ unicode?, image? }`); idempotent →
  // returns the Reaction (201 first add, 200 idempotent repeat). Fans out
  // `reaction.added` with the full object to WS subscribers via the hub.
  router.put("/:messageId/reactions/:key", signed, async (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");
    const messageId = requireParam(c, "messageId");
    const key = requireParam(c, "key");

    const body = ReactionPutBodySchema.parse(await readOptionalJson(c));

    const outcome = authorizeReaction(db, groupId, channelId, messageId, actor.actor);
    if (outcome.error) throw toAppError(outcome.error);

    // Idempotency: a repeat add returns the existing reaction (same id) → 200;
    // a brand-new reaction → 201.
    const existed = hasReaction(db, messageId, actor.actor, key);

    const reaction = addReaction(db, {
      messageId,
      channelId,
      groupId,
      author: actor.actor,
      key,
      ...(body.unicode !== undefined ? { unicode: body.unicode } : {}),
      ...(body.image !== undefined ? { image: body.image } : {}),
    });

    hub.publishToChannel(channelId, {
      type: "reaction.added",
      data: WsReactionAddedSchema.shape.data.parse({ groupId, channelId, reaction }),
    });

    return c.json(ReactionSchema.parse(reaction), existed ? 200 : 201);
  });

  // -- DELETE .../messages/:messageId/reactions/:key (§7.1, signed) --------
  // Remove your reaction → 204. Fans out `reaction.removed` to WS subscribers.
  router.delete("/:messageId/reactions/:key", signed, (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");
    const messageId = requireParam(c, "messageId");
    const key = requireParam(c, "key");

    const outcome = authorizeReaction(db, groupId, channelId, messageId, actor.actor);
    if (outcome.error) throw toAppError(outcome.error);

    removeReaction(db, messageId, actor.actor, key);

    hub.publishToChannel(channelId, {
      type: "reaction.removed",
      data: WsReactionRemovedSchema.shape.data.parse({
        groupId,
        channelId,
        messageId,
        key,
        author: actor.actor,
      }),
    });

    return c.body(null, 204);
  });

  return router;
}

/**
 * Optional body for `PUT …/reactions/{key}`: `{ unicode?, image? }` (§7.1). An
 * empty/absent body is allowed (the `{key}` carries the reaction identity); any
 * present `image` must be an https URI (validated by `ReactionSchema` on the way
 * out too, but rejected here for a clean 400).
 */
const ReactionPutBodySchema = z
  .object({
    unicode: z.string().optional(),
    image: z
      .string()
      .regex(/^https:\/\//)
      .optional(),
  })
  .passthrough();

/**
 * Read a JSON body if one was sent, else `{}`. The `PUT …/reactions/{key}` body
 * is OPTIONAL, so a request with no body (or an empty one) must not 400 on
 * `c.req.json()` — we tolerate a parse failure and treat it as no body.
 */
async function readOptionalJson(c: Context<AppBindings>): Promise<unknown> {
  try {
    const text = await c.req.text();
    if (!text || text.trim().length === 0) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}
