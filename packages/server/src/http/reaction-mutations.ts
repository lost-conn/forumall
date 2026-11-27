/**
 * Channel reaction add / remove (§7.1 "Reactions"), shared by the WS
 * `reaction.add` / `reaction.remove` commands (`http/ws/reactions.ts`) and the
 * REST `PUT` / `DELETE …/reactions/{key}` routes (`http/messages.ts`).
 *
 * Both run {@link authorizeReaction} (visibility 404, the add's `react` 403,
 * the message 404 — a tombstone too, for an add) and then make the change.
 * Only a change is fanned out over the hub:
 *
 *  - a first add fans out `reaction.added`; a **repeated add** changes nothing
 *    (the stored `Reaction` keeps its `id`, `createdAt`, `unicode`, `image`) and
 *    fans out nothing;
 *  - a remove that deletes the actor's reaction fans out `reaction.removed`; a
 *    **remove that removes nothing** fans out nothing.
 *
 * For a no-op the caller answers the requester: REST as for a change (the
 * existing `Reaction` / `204`), WebSocket with the correlated event to the
 * requesting connection alone ({@link reactionAddedEvent} /
 * {@link reactionRemovedEvent} with its `correlationId`).
 */
import { type Reaction, WsReactionAddedSchema, WsReactionRemovedSchema } from "@forumall/shared";

import type { Db } from "../db/index.ts";
import { addReaction, removeReaction } from "../provider/reactions.ts";
import type { CorrelatedReply, Hub, OutboundEvent } from "../provider/ws-hub.ts";
import { type MutationError, authorizeReaction } from "./message-mutations.ts";

/** The reaction a request names: its message and `key`, and who asks. */
export interface ReactionTarget {
  readonly groupId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly key: string;
  readonly actor: string;
  /** The WS command being answered: its connection gets the correlated copy. */
  readonly reply?: CorrelatedReply;
}

/** The optional `unicode` / `image` of an add (absent fields left out). */
export interface ReactionExtras {
  readonly unicode?: string;
  readonly image?: string;
}

/** An add: refused, or the `Reaction` now held and whether this add made it. */
export type AddReactionOutcome =
  | { readonly kind: "rejected"; readonly error: MutationError }
  | { readonly kind: "added" | "existing"; readonly reaction: Reaction };

/** A remove: refused, or whether it removed a reaction (`noop` when none). */
export type RemoveReactionOutcome =
  | { readonly kind: "rejected"; readonly error: MutationError }
  | { readonly kind: "removed" | "noop" };

/**
 * A validated `reaction.added` event. `correlationId` is for a frame sent to
 * one connection only (the answer to a repeated add); a live fan-out passes
 * none and lets {@link Hub.publishToChannel} correlate the requester's copy.
 */
export function reactionAddedEvent(
  groupId: string,
  channelId: string,
  reaction: Reaction,
  correlationId?: string,
): OutboundEvent {
  return {
    type: "reaction.added",
    ...(correlationId !== undefined ? { correlationId } : {}),
    data: WsReactionAddedSchema.shape.data.parse({ groupId, channelId, reaction }),
  };
}

/** A validated `reaction.removed` event; `correlationId` as for an add. */
export function reactionRemovedEvent(
  target: Omit<ReactionTarget, "reply">,
  correlationId?: string,
): OutboundEvent {
  const { groupId, channelId, messageId, key, actor } = target;
  return {
    type: "reaction.removed",
    ...(correlationId !== undefined ? { correlationId } : {}),
    data: WsReactionRemovedSchema.shape.data.parse({
      groupId,
      channelId,
      messageId,
      key,
      author: actor,
    }),
  };
}

/**
 * Add `target.actor`'s reaction in the §7.1 order of checks. `extras` is read
 * only after authorization, as the body rules are step 5. A first add is
 * stored and fanned out; a repeated add returns the existing `Reaction`
 * unchanged and fans out nothing.
 */
export function addChannelReaction(
  db: Db,
  hub: Hub,
  target: ReactionTarget,
  extras: () => ReactionExtras,
): AddReactionOutcome {
  const { groupId, channelId, messageId, key, actor } = target;
  const outcome = authorizeReaction(db, "add", groupId, channelId, messageId, actor);
  if (outcome.error) return { kind: "rejected", error: outcome.error };
  const { unicode, image } = extras();
  const { reaction, created } = addReaction(db, {
    messageId,
    channelId,
    groupId,
    author: actor,
    key,
    ...(unicode !== undefined ? { unicode } : {}),
    ...(image !== undefined ? { image } : {}),
  });
  if (!created) return { kind: "existing", reaction };
  hub.publishToChannel(channelId, reactionAddedEvent(groupId, channelId, reaction), target.reply);
  return { kind: "added", reaction };
}

/**
 * Remove `target.actor`'s reaction `key` in the §7.1 order of checks (no
 * `react` gate; a tombstone proceeds). A removal that happened is fanned out;
 * one that removes nothing is a `noop` and fans out nothing.
 */
export function removeChannelReaction(
  db: Db,
  hub: Hub,
  target: ReactionTarget,
): RemoveReactionOutcome {
  const { groupId, channelId, messageId, key, actor } = target;
  const outcome = authorizeReaction(db, "remove", groupId, channelId, messageId, actor);
  if (outcome.error) return { kind: "rejected", error: outcome.error };
  if (!removeReaction(db, messageId, actor, key)) return { kind: "noop" };
  hub.publishToChannel(channelId, reactionRemovedEvent(target), target.reply);
  return { kind: "removed" };
}
