/**
 * `/api/groups/:groupId/channels/:channelId/messages` router — message history
 * reads, creation and mutations (spec §5.3, §7.1, §7.2). Mounted under the channels router so both
 * `:groupId` and `:channelId` are in scope via merged request params.
 *
 *  - `GET /` (optional auth): read a page of the channel timeline. Authorized
 *    via the §11.3 read gate ({@link requireReadableChannel}) — a
 *    public/discoverable channel is readable by anyone able to read the group;
 *    a private/group channel only by a member. A missing group, or a channel
 *    that is missing or unreadable → the same 404. Query: `cursor` (opaque),
 *    `direction` (`backward` default | `forward`), `limit`. → `{ items, page:
 *    { nextCursor, prevCursor } }` per §7.2, validated against
 *    `MessagesPageSchema`.
 *  - `POST /` (signed): create a message (§7.1) — the REST equivalent of the WS
 *    `message.create`, sharing its logic (`message-create.ts`).
 *  - `PATCH` / `DELETE /{messageId}` (signed): edit / tombstone (§7.1), and
 *    `PUT` / `DELETE /{messageId}/reactions/{key}`; each fans out over the hub
 *    exactly as its WS equivalent does.
 */
import {
  MessageSchema,
  MessagesPageSchema,
  PagedResponseSchema,
  ReactionSchema,
  WsMessageUpdatedSchema,
} from "@forumall/shared";
import { type Context, Hono } from "hono";

import { listMessages, listReplies } from "../provider/messages.ts";
import { listReactions } from "../provider/reactions.ts";
import { requireReadableChannel } from "./channel-access.ts";
import { AppError, slugForErrorCode } from "./errors.ts";
import { createChannelMessage } from "./message-create.ts";
import { deleteChannelMessage } from "./message-delete.ts";
import { editChannelMessage } from "./message-edit.ts";
import type { MutationError } from "./message-mutations.ts";
import { parseReactionPutBody, reactionExtras } from "./reaction-body.ts";
import {
  type ReactionTarget,
  addChannelReaction,
  removeChannelReaction,
} from "./reaction-mutations.ts";
import { optionalSignature, requireSignature } from "./signature.ts";
import type { AppBindings } from "./types.ts";

/** Turn a {@link MutationError} into the {@link AppError} for its registry code. */
function toAppError(error: MutationError): AppError {
  return new AppError(slugForErrorCode(error.code), { detail: error.message });
}

/**
 * Read a path param guaranteed present by the mounted route (`:groupId` /
 * `:channelId` from the parent routers). Mirrors the channels router helper; the
 * empty-string fallback is unreachable for a route whose pattern requires it.
 */
function requireParam(c: Context<AppBindings>, name: string): string {
  return c.req.param(name) ?? "";
}

/** The reaction a `…/reactions/{key}` route names, for `actor`. */
function reactionTarget(c: Context<AppBindings>, actor: string): ReactionTarget {
  return {
    groupId: requireParam(c, "groupId"),
    channelId: requireParam(c, "channelId"),
    messageId: requireParam(c, "messageId"),
    key: requireParam(c, "key"),
    actor,
  };
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

    // Read gate (§11.3): an unreadable channel answers exactly as a missing one.
    requireReadableChannel(db, groupId, channelId, c.var.actor?.actor ?? null);

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

  // -- GET .../messages/:messageId/replies (§7.2, optional auth) -----------
  // Paged list of the replies to a message (its thread). Same read gate +
  // `messages-page` shape as the history read; defaults to oldest-reply-first.
  // Unknown group, or a missing or unreadable channel → 404; the parent message
  // need not exist (an empty page is a valid answer).
  router.get("/:messageId/replies", optional, (c) => {
    const { db } = c.var;
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");
    const messageId = requireParam(c, "messageId");

    requireReadableChannel(db, groupId, channelId, c.var.actor?.actor ?? null);

    const cursor = c.req.query("cursor") ?? null;
    const direction = c.req.query("direction") === "backward" ? "backward" : "forward";
    const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

    const page = listReplies(db, channelId, messageId, {
      cursor,
      direction,
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json(MessagesPageSchema.parse(page));
  });

  // -- POST .../messages (§7.1 create, signed) -----------------------------
  // The REST equivalent of `message.create`: the `MessageCreate` body, the same
  // ordered checks, idempotency and fan-out (shared `createChannelMessage`).
  // 201 + the new Message; 200 + the existing Message for a duplicate
  // `clientMessageId` (nothing fanned out). The fan-out `message.created` has
  // no `correlationId` — no WS command caused it.
  router.post("/", signed, async (c) => {
    const { config, db, hub, federationFetch } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const body = await c.req.json().catch(() => {
      throw AppError.badRequest({ detail: "request body must be valid JSON" });
    });
    const outcome = createChannelMessage(
      { config, db, hub, federationFetch },
      {
        groupId: requireParam(c, "groupId"),
        channelId: requireParam(c, "channelId"),
        author: actor.actor,
        body,
      },
    );
    if (outcome.kind === "rejected") throw toAppError(outcome.error);
    return c.json(
      MessageSchema.parse(outcome.record.message),
      outcome.kind === "created" ? 201 : 200,
    );
  });

  // -- PATCH .../messages/:messageId (§7.1 edit, signed) -------------------
  // Author-only + edit window; returns the updated Message (with `editedAt`).
  // Fans out `message.updated` to WS subscribers via the shared hub.
  router.patch("/:messageId", signed, async (c) => {
    const { db, config, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");
    const messageId = requireParam(c, "messageId");

    // A body that is not JSON (→ undefined) or not an object is 400 first;
    // the rest of the body is judged after 404 / 403: see `editChannelMessage`.
    const body: unknown = await c.req.json().catch(() => undefined);
    const outcome = editChannelMessage(db, config, {
      groupId,
      channelId,
      messageId,
      actor: actor.actor,
      body,
    });
    if (outcome.error) throw toAppError(outcome.error);
    const { record } = outcome;

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
  // Author OR a `moderate` member; soft-delete → 204, fanning out
  // `message.deleted` to WS subscribers via the shared hub. A repeated delete
  // of a tombstone is also 204 and fans out nothing (`message-delete.ts`).
  router.delete("/:messageId", signed, (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const outcome = deleteChannelMessage(db, hub, {
      groupId: requireParam(c, "groupId"),
      channelId: requireParam(c, "channelId"),
      messageId: requireParam(c, "messageId"),
      actor: actor.actor,
    });
    if (outcome.kind === "rejected") throw toAppError(outcome.error);
    return c.body(null, 204);
  });

  // -- GET .../messages/:messageId/reactions (§7.1, optional auth) ----------
  // Paginated list of `Reaction` objects (history / late-joiners). Gated
  // exactly like the message-history read: an unknown group, or a missing or
  // unreadable channel → 404 (§11.3).
  router.get("/:messageId/reactions", optional, (c) => {
    const { db } = c.var;
    const groupId = requireParam(c, "groupId");
    const channelId = requireParam(c, "channelId");
    const messageId = requireParam(c, "messageId");

    requireReadableChannel(db, groupId, channelId, c.var.actor?.actor ?? null);

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
  // Add your reaction (optional body `{ unicode?, image? }`), judged after the
  // 404/403 checks; idempotent → returns the Reaction (201 first add, 200 for a
  // repeated add, which changes nothing). Only a first add fans out
  // `reaction.added` to WS subscribers (`reaction-mutations.ts`).
  router.put("/:messageId/reactions/:key", signed, async (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const text = await c.req.text();
    const outcome = addChannelReaction(db, hub, reactionTarget(c, actor.actor), () =>
      reactionExtras(parseReactionPutBody(text)),
    );
    if (outcome.kind === "rejected") throw toAppError(outcome.error);
    return c.json(ReactionSchema.parse(outcome.reaction), outcome.kind === "added" ? 201 : 200);
  });

  // -- DELETE .../messages/:messageId/reactions/:key (§7.1, signed) --------
  // Remove your reaction → 204 either way; only a removal that happened fans
  // out `reaction.removed` (`reaction-mutations.ts`).
  router.delete("/:messageId/reactions/:key", signed, (c) => {
    const { db, hub } = c.var;
    const actor = c.var.actor;
    if (!actor) throw AppError.unauthorized();
    const outcome = removeChannelReaction(db, hub, reactionTarget(c, actor.actor));
    if (outcome.kind === "rejected") throw toAppError(outcome.error);
    return c.body(null, 204);
  });

  return router;
}
