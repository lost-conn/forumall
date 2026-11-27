/** §7.1 Reactions: `reaction.add` / `reaction.remove` and their fan-out. */
import {
  WsReactionAddSchema,
  WsReactionAddedSchema,
  WsReactionRemoveSchema,
  WsReactionRemovedSchema,
} from "@forumall/shared";
import { addReaction, removeReaction } from "../../provider/reactions.ts";
import { authorizeReaction } from "../message-mutations.ts";
import { type ConnState, type WsContext, type WsCtx, errorEvent } from "./connection.ts";

/**
 * §7.1 Reactions: add the connection actor's reaction to a message. Authz
 * ({@link authorizeReaction}): a channel the actor cannot read, or a missing
 * message → `not_found`, exactly as for a missing channel (§11.3); a reader who
 * is not a member, or lacks the channel's `react` permission → `forbidden`
 * (§11, §5.2.1). There is no per-key gate. The add is idempotent on
 * `(message, author, key)` — a repeat add returns the existing reaction. On
 * success fan out `reaction.added` carrying the FULL `Reaction` object to every
 * channel subscriber (only the requesting connection's copy correlates to the
 * request id).
 */
export function handleReactionAdd(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { db, hub } = ctx;
  const parsed = WsReactionAddSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed reaction.add command", frameId));
    return;
  }
  const author = state.actor;
  const hubConn = state.hubConn;
  if (!author || !hubConn) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId, key, unicode, image } = parsed.data.data;
  const outcome = authorizeReaction(db, "add", groupId, channelId, messageId, author);
  if (outcome.error) {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
    return;
  }

  const reaction = addReaction(db, {
    messageId,
    channelId,
    groupId,
    author,
    key,
    ...(unicode !== undefined ? { unicode } : {}),
    ...(image !== undefined ? { image } : {}),
  });
  hub.publishToChannel(
    channelId,
    {
      type: "reaction.added",
      data: WsReactionAddedSchema.shape.data.parse({ groupId, channelId, reaction }),
    },
    { conn: hubConn, correlationId: frameId },
  );
}

/**
 * §7.1 Reactions: remove the connection actor's reaction `key` from a message.
 * Authz ({@link authorizeReaction}): read access and an existing message, else
 * `not_found`; removal is not gated on `react` or membership (§5.2.1 `react`
 * gates adding). Removal is idempotent (a no-op if the actor held no such
 * reaction). A removal that happened fans out `reaction.removed { groupId,
 * channelId, messageId, key, author }` to channel subscribers (only the
 * requesting connection's copy correlates to the request id). A no-op answers
 * the requester alone with that correlated event, so its command still
 * resolves, and broadcasts nothing: a reader who holds no such reaction must
 * not announce one (§11).
 */
export function handleReactionRemove(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { db, hub } = ctx;
  const parsed = WsReactionRemoveSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed reaction.remove command", frameId));
    return;
  }
  const author = state.actor;
  const hubConn = state.hubConn;
  if (!author || !hubConn) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId, key } = parsed.data.data;
  const outcome = authorizeReaction(db, "remove", groupId, channelId, messageId, author);
  if (outcome.error) {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
    return;
  }

  const event = {
    type: "reaction.removed",
    data: WsReactionRemovedSchema.shape.data.parse({ groupId, channelId, messageId, key, author }),
  };
  if (removeReaction(db, messageId, author, key)) {
    hub.publishToChannel(channelId, event, { conn: hubConn, correlationId: frameId });
  } else {
    hub.send(ws, { ...event, correlationId: frameId });
  }
}
