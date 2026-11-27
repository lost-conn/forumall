/**
 * §7.1 "Typing indicators" (channels) and §7.4 DM typing: `typing.start` /
 * `typing.stop`, the per-connection auto-expiry timers, and clearing them all
 * when a connection goes away (so no indicator is left stuck).
 */
import {
  WsChannelTypingSchema,
  WsDmTypingSchema,
  WsTypingStartSchema,
  WsTypingStopSchema,
} from "@forumall/shared";
import type { Db } from "../../db/index.ts";
import { getReadableChannel } from "../../provider/channels.ts";
import { getDmConversationRow } from "../../provider/dms.ts";
import { getMembership } from "../../provider/permissions.ts";
import type { OutboundEvent } from "../../provider/ws-hub.ts";
import { CHANNEL_NOT_FOUND } from "../channel-access.ts";
import type { MutationError } from "../message-mutations.ts";
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
 * May `actor` type in `channelId`? `null` when allowed, else the error to send:
 *
 *  - a channel that does not exist or that the actor cannot read → `not_found`,
 *    exactly as for a missing channel (§11.3);
 *  - a reader who is not a member of the channel's group → `forbidden`:
 *    reading a `public` channel never implies typing in it (§11).
 *
 * §11 requires "membership plus the relevant permission"; no permission is
 * defined for typing (§5.2.1 names `view`, `post:<type>` and `react`), so
 * membership is the bar.
 */
function typingRefusal(db: Db, channelId: string, actor: string): MutationError | null {
  const channel = getReadableChannel(db, channelId, actor);
  if (!channel) return CHANNEL_NOT_FOUND;
  if (!getMembership(db, channel.groupId, actor)) {
    return { code: "forbidden", message: "only group members may type in this channel" };
  }
  return null;
}

/**
 * Clear a connection's typing timer for `channelId` without fanning out. Used
 * on explicit stop (we fan out separately) and when resetting on refresh.
 */
function clearTypingTimer(state: ConnState, channelId: string): void {
  const timer = state.typingTimers.get(channelId);
  if (timer !== undefined) {
    clearTimeout(timer);
    state.typingTimers.delete(channelId);
  }
}

/** Build a validated `dm.typing` event (§7.4, mirrors `channel.typing`). */
function dmTypingEvent(dmId: string, user: string, typingState: "start" | "stop"): OutboundEvent {
  return {
    type: "dm.typing",
    data: WsDmTypingSchema.shape.data.parse({ dmId, user, state: typingState }),
  };
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
  const { hub } = ctx;
  for (const [dmId, entry] of state.dmTypingTimers) {
    clearTimeout(entry.timer);
    if (emitStop && state.actor) {
      hub.publishToActor(entry.counterparty, dmTypingEvent(dmId, state.actor, "stop"));
    }
  }
  state.dmTypingTimers.clear();
}

/**
 * Clear every active typing indicator for a connection, optionally fanning out
 * a `stop` for each first. On disconnect (`emitStop`) we MUST emit a `stop` per
 * channel the actor was typing in, so a dropped connection never leaves an
 * indicator stuck (§7.1). On a clean teardown after the hub is gone we still
 * clear the timers so none leak past the connection.
 */
export function clearAllTyping(ctx: WsCtx, state: ConnState, emitStop: boolean): void {
  const { hub } = ctx;
  for (const [channelId, timer] of state.typingTimers) {
    clearTimeout(timer);
    if (emitStop && state.actor) {
      hub.publishToChannel(channelId, typingEvent(channelId, state.actor, "stop"));
    }
  }
  state.typingTimers.clear();
}
/**
 * §7.1 Typing indicators: signal that the connection's actor started typing in
 * a channel. Authorize via {@link typingRefusal} — a missing or unreadable
 * channel gets `not_found`, a non-member reader `forbidden`, and neither any
 * fan-out. On success fan out `channel.typing
 * { channelId, user, state: "start" }` to every channel subscriber (matching
 * message fan-out, which includes the sender; clients filter their own user)
 * and (re)arm the per-(connection, channel) auto-expiry timer: if no refreshing
 * `typing.start` arrives within {@link Config.typingTimeoutMs}, the timer fans
 * out an automatic `stop`. Typing is ephemeral soft state — never persisted.
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
    // The conversation row is a LOCAL inbox row (see ConnState.localHandle); a
    // remote actor has none here, so they cannot type into a local inbox.
    const handle = state.localHandle;
    const conv = handle !== undefined ? getDmConversationRow(db, handle, dmId, authority) : null;
    if (!conv) {
      hub.send(ws, errorEvent("forbidden", "not authorized to type in this conversation", frameId));
      return;
    }
    const counterparty = conv.counterparty;
    // Fan the `start` to the counterparty (the typer doesn't need its own echo
    // for a 2-party DM, mirroring how DM messages deliver to the recipient).
    hub.publishToActor(counterparty, dmTypingEvent(dmId, actor, "start"));
    // (Re)arm the per-(connection, dmId) auto-expiry timer.
    clearDmTypingTimer(state, dmId);
    const timer = setTimeout(() => {
      state.dmTypingTimers.delete(dmId);
      hub.publishToActor(counterparty, dmTypingEvent(dmId, actor, "stop"));
    }, config.typingTimeoutMs);
    state.dmTypingTimers.set(dmId, { timer, counterparty });
    return;
  }

  const channelId = parsed.data.data.channelId;
  if (channelId === undefined) {
    hub.send(ws, errorEvent("bad_request", "typing.start needs a channelId or dmId", frameId));
    return;
  }
  const refusal = typingRefusal(db, channelId, actor);
  if (refusal) {
    hub.send(ws, errorEvent(refusal.code, refusal.message, frameId));
    return;
  }

  // Fan out the `start` (includes the typer's own connection, like message
  // fan-out; clients drop their own user).
  hub.publishToChannel(channelId, typingEvent(channelId, actor, "start"));

  // (Re)arm the auto-expiry timer: a refreshing `typing.start` resets it.
  clearTypingTimer(state, channelId);
  const timer = setTimeout(() => {
    // Window elapsed with no refresh → auto-emit a `stop` (§7.1) and forget it.
    state.typingTimers.delete(channelId);
    hub.publishToChannel(channelId, typingEvent(channelId, actor, "stop"));
  }, config.typingTimeoutMs);
  state.typingTimers.set(channelId, timer);
}

/**
 * §7.1 Typing indicators: signal that the connection's actor stopped typing in
 * a channel. Cancels the auto-expiry timer (so it doesn't double-emit) and fans
 * out `channel.typing { channelId, user, state: "stop" }` — when this
 * connection had a pending `start` there (so an actor who lost access can still
 * clear their own indicator), or when the actor may type there now (a `start`
 * from another of their connections). Otherwise nothing happens: there is no
 * error, so a missing and a hidden channel answer alike (§11.3), and a
 * non-member reader cannot inject typing events (§11). A malformed frame still
 * errors.
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
    // caller's own LOCAL conversation row) so an explicit stop still reaches the
    // other party. A remote actor has no local row — see ConnState.localHandle.
    const entry = state.dmTypingTimers.get(dmId);
    const handle = state.localHandle;
    const counterparty =
      entry?.counterparty ??
      (handle !== undefined
        ? getDmConversationRow(db, handle, dmId, authority)?.counterparty
        : undefined);
    clearDmTypingTimer(state, dmId);
    if (counterparty) hub.publishToActor(counterparty, dmTypingEvent(dmId, actor, "stop"));
    return;
  }

  const channelId = parsed.data.data.channelId;
  if (channelId === undefined) return; // nothing to stop
  const hadStart = state.typingTimers.has(channelId);
  // Cancel the pending auto-expiry; we're emitting the `stop` explicitly now.
  clearTypingTimer(state, channelId);
  if (hadStart || typingRefusal(db, channelId, actor) === null) {
    hub.publishToChannel(channelId, typingEvent(channelId, actor, "stop"));
  }
}
