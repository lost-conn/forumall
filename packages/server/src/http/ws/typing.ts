/**
 * §7.1 "Typing indicators" (channels) and §7.4 DM typing: `typing.start` /
 * `typing.stop`, the auto-expiry timers (channel starts are the actor's, kept
 * in `ctx.channelTyping`; DM starts per connection), and clearing them all
 * when a connection goes away (so no indicator is left stuck).
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

/** Clear a connection's DM typing timer for `dmId` without fanning out. */
function clearDmTypingTimer(state: ConnState, dmId: string): void {
  const entry = state.dmTypingTimers.get(dmId);
  if (entry !== undefined) {
    clearTimeout(entry.timer);
    state.dmTypingTimers.delete(dmId);
  }
}

/**
 * Clear every active DM typing indicator for a connection, optionally fanning
 * out a `stop` to each counterparty first (on disconnect, so a dropped
 * connection never leaves a stuck indicator — mirrors {@link clearAllTyping}).
 */
export function clearAllDmTyping(ctx: WsCtx, state: ConnState, emitStop: boolean): void {
  const { hub, authority } = ctx;
  for (const [dmId, entry] of state.dmTypingTimers) {
    clearTimeout(entry.timer);
    if (emitStop && state.actor) {
      const stop = dmTypingEvent(dmId, state.actor, "stop");
      deliverDmTyping(hub, authority, dmId, entry.counterparty, stop);
    }
  }
  state.dmTypingTimers.clear();
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
 * ephemeral soft state — never persisted.
 */
export function handleTypingStart(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { config, db, hub, authority } = ctx;
  const parsed = WsTypingStartSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed typing.start command", frameId));
    return;
  }
  const actor = state.actor;
  if (!actor) return; // unreachable: only authenticated connections reach here

  const dmId = parsed.data.data.dmId;
  // --- DM-scoped typing (§7.4) ------------------------------------------
  if (dmId !== undefined) {
    // A non-participant gets exactly what an unknown dmId gets (§7.4
    // "Non-participants answer as unknown").
    const counterparty = dmTypingCounterparty(ctx, state, dmId);
    if (counterparty === null) {
      hub.send(ws, errorEvent("not_found", "No such conversation", frameId));
      return;
    }
    // Fan the `start` to the counterparty (the typer doesn't need its own echo
    // for a 2-party DM, mirroring how DM messages deliver to the recipient).
    deliverDmTyping(hub, authority, dmId, counterparty, dmTypingEvent(dmId, actor, "start"));
    // (Re)arm the per-(connection, dmId) auto-expiry timer.
    clearDmTypingTimer(state, dmId);
    const timer = setTimeout(() => {
      state.dmTypingTimers.delete(dmId);
      deliverDmTyping(hub, authority, dmId, counterparty, dmTypingEvent(dmId, actor, "stop"));
    }, config.typingTimeoutMs);
    state.dmTypingTimers.set(dmId, { timer, counterparty });
    return;
  }

  const channelId = parsed.data.data.channelId;
  if (channelId === undefined) {
    hub.send(ws, errorEvent("bad_request", "typing.start needs a channelId or dmId", frameId));
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
 * to subscribers or to the requester (§7.1). DM stops (§7.4) are per
 * connection.
 */
export function handleTypingStop(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { db, hub, authority } = ctx;
  const parsed = WsTypingStopSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed typing.stop command", frameId));
    return;
  }
  const actor = state.actor;
  if (!actor) return; // unreachable: only authenticated connections reach here

  const dmId = parsed.data.data.dmId;
  if (dmId !== undefined) {
    // Resolve the counterparty (prefer the live timer's, fall back to the
    // participant lookup) so an explicit stop still reaches the other party.
    const counterparty =
      state.dmTypingTimers.get(dmId)?.counterparty ?? dmTypingCounterparty(ctx, state, dmId);
    clearDmTypingTimer(state, dmId);
    if (counterparty !== null) {
      deliverDmTyping(hub, authority, dmId, counterparty, dmTypingEvent(dmId, actor, "stop"));
    }
    return;
  }

  const channelId = parsed.data.data.channelId;
  if (channelId === undefined) {
    hub.send(ws, errorEvent("bad_request", "typing.stop needs a channelId or dmId", frameId));
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
