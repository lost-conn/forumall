/**
 * §7.1 "Typing indicators" (channels) and §7.4 DM typing: `typing.start` /
 * `typing.stop`, whose `channelId` names a channel or, as `dm_…`, a DM
 * conversation. Typing is the actor's state across connections, with an
 * auto-expiry timer per connection (`ctx.channelTyping` / `ctx.dmTyping`), and
 * a closing connection's starts are dropped (so no indicator is left stuck).
 */
import {
  MessageKindSchema,
  WsChannelTypingSchema,
  WsDmTypingSchema,
  WsTypingStartSchema,
  WsTypingStopSchema,
} from "@forumall/shared";
import type { Db } from "../../db/index.ts";
import { getReadableChannel } from "../../provider/channels.ts";
import { getDmConversationRow } from "../../provider/dms.ts";
import { canPostKind } from "../../provider/permissions.ts";
import type { Hub, OutboundEvent } from "../../provider/ws-hub.ts";
import { CHANNEL_NOT_FOUND } from "../channel-access.ts";
import { domainOf, resolveLocalDmOwner } from "../dm-request.ts";
import { type MutationError, memberChannelContext } from "../message-mutations.ts";
import { type ConnState, type WsContext, type WsCtx, errorEvent } from "./connection.ts";

/** Build a validated `channel.typing` event (§7.1 "Typing indicators"). */
function typingEvent(
  channelId: string,
  user: string,
  typingState: "start" | "stop",
): OutboundEvent {
  return {
    type: "channel.typing",
    data: WsChannelTypingSchema.shape.data.parse({ channelId, user, state: typingState }),
  };
}

/**
 * May `actor` start typing in `channelId` (§7.1 "Typing indicators")? `null`
 * when allowed, else the error to send:
 *
 *  - a channel that does not exist or that the actor cannot read → `not_found`,
 *    exactly as for a missing channel (§11.3);
 *  - a reader who holds no `post:<type>` grant there, for any `type` (§5.2.1:
 *    the channel's override, else the group's `post`) → `forbidden`. A
 *    non-member holds no grant: reading a `public` channel never implies
 *    typing in it (§11). A reply-restricted actor holds a grant, so it types.
 */
function typingStartRefusal(db: Db, channelId: string, actor: string): MutationError | null {
  const channel = getReadableChannel(db, channelId, actor);
  if (!channel) return CHANNEL_NOT_FOUND;
  const ctx = memberChannelContext(db, channel, actor);
  if (ctx && MessageKindSchema.options.some((kind) => canPostKind(ctx, kind))) return null;
  return { code: "forbidden", message: "typing here needs permission to post in this channel" };
}

/** Build a validated `dm.typing` event (§7.4, mirrors `channel.typing`). */
function dmTypingEvent(dmId: string, user: string, typingState: "start" | "stop"): OutboundEvent {
  return {
    type: "dm.typing",
    data: WsDmTypingSchema.shape.data.parse({ dmId, user, state: typingState }),
  };
}

/**
 * The counterparty of the connection's actor in `dmId`, or `null` when the actor
 * is not a participant (§7.4): the counterparty of a local actor's consistent
 * conversation row, else the local user the `dmId` derives from together with
 * the actor (which also covers a remote participant connected here directly).
 */
function dmTypingCounterparty(ctx: WsCtx, state: ConnState, dmId: string): string | null {
  const { config, db, authority } = ctx;
  const handle = state.localHandle;
  const row = handle !== undefined ? getDmConversationRow(db, handle, dmId, authority) : null;
  if (row) return row.counterparty;
  if (state.actor === undefined) return null;
  const owner = resolveLocalDmOwner(db, config, state.actor, dmId);
  return owner !== null ? `${owner}@${authority}` : null;
}

/**
 * Deliver a `dm.typing` to `counterparty` (§7.4): implicitly when it is a local
 * user, and to its `dmId` subscriptions here either way — the only way a remote
 * counterparty, with no inbox here, receives DM events (one frame each).
 */
function deliverDmTyping(
  hub: Hub,
  authority: string,
  dmId: string,
  counterparty: string,
  event: OutboundEvent,
): void {
  hub.publishToAudience(
    {
      actors: domainOf(counterparty) === authority ? [counterparty] : [],
      channelId: dmId,
      subscribedActors: [counterparty],
    },
    event,
  );
}

/**
 * Drop every DM typing start a closing connection holds. Where that ends the
 * actor's typing in a conversation (no other connection of theirs still types
 * there) a `stop` is delivered to the counterparty, so a dropped connection
 * never leaves an indicator stuck (§7.4, mirrors {@link clearAllTyping}).
 */
export function clearAllDmTyping(ctx: WsCtx, state: ConnState): void {
  const { hub, authority, dmTyping } = ctx;
  const actor = state.actor;
  if (!actor) return; // an unauthenticated connection never typed
  for (const dmId of dmTyping.dropConnection(state, actor)) {
    // The actor typed here, so it is a participant and the lookup succeeds.
    const counterparty = dmTypingCounterparty(ctx, state, dmId);
    if (counterparty !== null) {
      deliverDmTyping(hub, authority, dmId, counterparty, dmTypingEvent(dmId, actor, "stop"));
    }
  }
}

/**
 * Drop every channel typing start a closing connection holds. Where that ends
 * the actor's typing (no other connection of theirs still types there) a
 * `stop` is fanned out, so a dropped connection never leaves an indicator
 * stuck (§7.1).
 */
export function clearAllTyping(ctx: WsCtx, state: ConnState): void {
  const { hub, channelTyping } = ctx;
  const actor = state.actor;
  if (!actor) return; // an unauthenticated connection never typed
  for (const channelId of channelTyping.dropConnection(state, actor)) {
    hub.publishToChannel(channelId, typingEvent(channelId, actor, "stop"));
  }
}
/**
 * §7.1 Typing indicators: signal that the connection's actor started typing in
 * a channel. Authorize via {@link typingStartRefusal} — a missing or unreadable
 * channel gets `not_found`, a reader with no `post:<type>` grant `forbidden`,
 * and neither any fan-out. On success fan out `channel.typing
 * { channelId, user, state: "start" }` to every channel subscriber (matching
 * message fan-out, which includes the sender; clients filter their own user),
 * with no acknowledgement to the requester, and (re)arm this connection's
 * auto-expiry timer in `ctx.channelTyping`: if no refreshing `typing.start`
 * arrives within {@link Config.typingTimeoutMs}, and no other connection of
 * the actor's still types there, an automatic `stop` is fanned out. Typing is
 * ephemeral soft state — never persisted. A `dm_…` target is a DM start
 * ({@link dmTypingStart}).
 */
export function handleTypingStart(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { config, db, hub } = ctx;
  const parsed = WsTypingStartSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed typing.start command", frameId));
    return;
  }
  const actor = state.actor;
  if (!actor) return; // unreachable: only authenticated connections reach here

  const channelId = parsed.data.data.channelId;
  if (isDmId(channelId)) {
    dmTypingStart(ctx, ws, state, actor, channelId, frameId);
    return;
  }
  const refusal = typingStartRefusal(db, channelId, actor);
  if (refusal) {
    hub.send(ws, errorEvent(refusal.code, refusal.message, frameId));
    return;
  }

  // Fan out the `start`, uncorrelated (a successful start is not acknowledged,
  // §7.1); it reaches the typer's own subscribed connections like any
  // subscriber's, and clients drop their own user.
  hub.publishToChannel(channelId, typingEvent(channelId, actor, "start"));

  // (Re)arm this connection's auto-expiry timer: a refreshing `typing.start`
  // resets it. When it lapses with no other connection of the actor's still
  // typing here, auto-emit a `stop` (§7.1).
  ctx.channelTyping.start(state, actor, channelId, config.typingTimeoutMs, () => {
    hub.publishToChannel(channelId, typingEvent(channelId, actor, "stop"));
  });
}

/**
 * §7.1 Typing indicators: signal that the connection's actor stopped typing in
 * a channel. A channel that does not exist or that the actor cannot read is
 * answered `not_found`, as a missing channel (§11.3). An active start of the
 * actor's there — from this connection or another of theirs — is ended (its
 * auto-expiry cancelled) and `channel.typing { state: "stop" }` fanned out;
 * that holds even for an actor who has just lost access, so their indicator
 * does not linger. A stop with no active start is a no-op that sends nothing,
 * to subscribers or to the requester (§7.1). A `dm_…` target is a DM stop
 * ({@link dmTypingStop}).
 */
export function handleTypingStop(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { db, hub } = ctx;
  const parsed = WsTypingStopSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed typing.stop command", frameId));
    return;
  }
  const actor = state.actor;
  if (!actor) return; // unreachable: only authenticated connections reach here

  const channelId = parsed.data.data.channelId;
  if (isDmId(channelId)) {
    dmTypingStop(ctx, ws, state, actor, channelId, frameId);
    return;
  }
  // End the actor's typing here, on every connection of theirs. Only a start
  // that was active is announced as stopped: otherwise nothing is sent.
  if (ctx.channelTyping.stop(actor, channelId)) {
    hub.publishToChannel(channelId, typingEvent(channelId, actor, "stop"));
  }
  if (!getReadableChannel(db, channelId, actor)) {
    hub.send(ws, errorEvent(CHANNEL_NOT_FOUND.code, CHANNEL_NOT_FOUND.message, frameId));
  }
}

/** Does a typing `channelId` name a DM conversation (`dm_…`, §7.4)? */
function isDmId(channelId: string): boolean {
  return channelId.startsWith("dm_");
}

/**
 * §7.4 DM typing start: any participant may type (no group permission); a
 * non-participant gets exactly what an unknown `dmId` gets (`not_found`, §7.4
 * "Non-participants answer as unknown"). A successful start is not
 * acknowledged: the `start` goes to the counterparty only (the typer needs no
 * echo in a two-party DM) and (re)arms this connection's auto-expiry timer in
 * `ctx.dmTyping`, after which — if no other connection of the actor's still
 * types there — a `stop` is delivered.
 */
function dmTypingStart(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  actor: string,
  dmId: string,
  frameId: string,
): void {
  const { config, hub, authority } = ctx;
  const counterparty = dmTypingCounterparty(ctx, state, dmId);
  if (counterparty === null) {
    hub.send(ws, errorEvent("not_found", "No such conversation", frameId));
    return;
  }
  deliverDmTyping(hub, authority, dmId, counterparty, dmTypingEvent(dmId, actor, "start"));
  ctx.dmTyping.start(state, actor, dmId, config.typingTimeoutMs, () => {
    deliverDmTyping(hub, authority, dmId, counterparty, dmTypingEvent(dmId, actor, "stop"));
  });
}

/**
 * §7.4 DM typing stop: a non-participant gets `not_found`, as for an unknown
 * `dmId`. A participant's stop ends the actor's typing in the conversation on
 * every connection of theirs and delivers a `stop` to the counterparty; with
 * no active start it is a no-op that sends nothing.
 */
function dmTypingStop(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  actor: string,
  dmId: string,
  frameId: string,
): void {
  const { hub, authority } = ctx;
  const counterparty = dmTypingCounterparty(ctx, state, dmId);
  if (counterparty === null) {
    hub.send(ws, errorEvent("not_found", "No such conversation", frameId));
    return;
  }
  if (ctx.dmTyping.stop(actor, dmId)) {
    deliverDmTyping(hub, authority, dmId, counterparty, dmTypingEvent(dmId, actor, "stop"));
  }
}
