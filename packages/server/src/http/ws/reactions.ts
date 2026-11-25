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
 * §7.1 Reactions: add the connection actor's reaction to a message. Authz: the
 * actor must be able to SEE the channel and the message must exist
 * ({@link authorizeReaction}); there is no per-key permission gate. The add is
 * idempotent on `(message, author, key)` — a repeat add returns the existing
 * reaction. On success fan out `reaction.added` carrying the FULL `Reaction`
 * object to every channel subscriber (the author's own copy correlates to the
 * request id). Missing message / no channel access → `error` (404/403).
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
  if (!author) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId, key, unicode, image } = parsed.data.data;
  const outcome = authorizeReaction(db, groupId, channelId, messageId, author);
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
  hub.publishToChannel(channelId, {
    type: "reaction.added",
    correlationId: frameId,
    data: WsReactionAddedSchema.shape.data.parse({ groupId, channelId, reaction }),
  });
}

/**
 * §7.1 Reactions: remove the connection actor's reaction `key` from a message.
 * Same visibility/existence authz as {@link handleReactionAdd}. Removal is
 * idempotent (a no-op if the actor held no such reaction). Always fan out
 * `reaction.removed { groupId, channelId, messageId, key, author }` to channel
 * subscribers (the author's own copy correlates to the request id). Missing
 * message / no channel access → `error` (404/403).
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
  if (!author) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId, key } = parsed.data.data;
  const outcome = authorizeReaction(db, groupId, channelId, messageId, author);
  if (outcome.error) {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
    return;
  }

  removeReaction(db, messageId, author, key);
  hub.publishToChannel(channelId, {
    type: "reaction.removed",
    correlationId: frameId,
    data: WsReactionRemovedSchema.shape.data.parse({
      groupId,
      channelId,
      messageId,
      key,
      author,
    }),
  });
}
