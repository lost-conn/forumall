/**
 * §7.1 Reactions: the `reaction.add` / `reaction.remove` commands, over the
 * logic shared with REST (`http/reaction-mutations.ts`).
 */
import { WsReactionAddSchema, WsReactionRemoveSchema } from "@forumall/shared";
import {
  addChannelReaction,
  reactionAddedEvent,
  reactionRemovedEvent,
  removeChannelReaction,
} from "../reaction-mutations.ts";
import { type ConnState, type WsContext, type WsCtx, errorEvent } from "./connection.ts";

/**
 * §7.1 Reactions: add the connection actor's reaction to a message. Authz
 * (`authorizeReaction`): a channel the actor cannot read, a missing message or
 * a tombstone → `not_found`, exactly as for a missing channel (§11.3); a reader
 * who is not a member, or lacks the channel's `react` permission → `forbidden`
 * (§11, §5.2.1). A first add fans out `reaction.added` carrying the FULL
 * `Reaction` to every channel subscriber, this connection getting the one
 * correlated copy. A repeated add (§7.1) changes nothing: this connection
 * alone gets a correlated `reaction.added` with the existing `Reaction`.
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
  const actor = state.actor;
  const hubConn = state.hubConn;
  if (!actor || !hubConn) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId, key, unicode, image } = parsed.data.data;
  const target = {
    groupId,
    channelId,
    messageId,
    key,
    actor,
    reply: { conn: hubConn, correlationId: frameId },
  };
  const outcome = addChannelReaction(db, hub, target, () => ({
    ...(unicode !== undefined ? { unicode } : {}),
    ...(image !== undefined ? { image } : {}),
  }));
  if (outcome.kind === "rejected") {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
  } else if (outcome.kind === "existing") {
    hub.send(ws, reactionAddedEvent(groupId, channelId, outcome.reaction, frameId));
  }
}

/**
 * §7.1 Reactions: remove the connection actor's reaction `key` from a message.
 * Authz: read access and an existing message (a tombstone included), else
 * `not_found`; removal is not gated on `react` or membership (§5.2.1 `react`
 * gates adding). A removal that happened fans out `reaction.removed { groupId,
 * channelId, messageId, key, author }` to channel subscribers, this connection
 * getting the one correlated copy. A remove that removes nothing answers this
 * connection alone with that correlated event and broadcasts nothing: a reader
 * who holds no such reaction must not announce one (§7.1, §11).
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
  const actor = state.actor;
  const hubConn = state.hubConn;
  if (!actor || !hubConn) return; // unreachable: only authenticated connections reach here

  const { groupId, channelId, messageId, key } = parsed.data.data;
  const target = { groupId, channelId, messageId, key, actor };
  const outcome = removeChannelReaction(db, hub, {
    ...target,
    reply: { conn: hubConn, correlationId: frameId },
  });
  if (outcome.kind === "rejected") {
    hub.send(ws, errorEvent(outcome.error.code, outcome.error.message, frameId));
  } else if (outcome.kind === "noop") {
    hub.send(ws, reactionRemovedEvent(target, frameId));
  }
}
