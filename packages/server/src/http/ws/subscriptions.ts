/**
 * §7.1 Subscriptions: `subscribe` (with per-channel authorization and `since`
 * resume replay) and `unsubscribe`.
 */
import { WsSubscribeSchema, WsUnsubscribeSchema } from "@forumall/shared";
import { canViewChannel, getChannelRow } from "../../provider/channels.ts";
import { isDmParticipant } from "../../provider/dms.ts";
import {
  type MessageRecord,
  decodeMessageCursor,
  resumeMessages,
} from "../../provider/messages.ts";
import { createdEvent } from "../message-create.ts";
import { type ConnState, type WsContext, type WsCtx, errorEvent } from "./connection.ts";

/**
 * §7.1 Subscriptions + resume: enforce per-channel visibility (membership +
 * tier) at subscribe-time, ack the readable ones, refuse the rest, and — for
 * any channel carrying a `since` cursor — REPLAY the post-cursor timeline
 * before any live event flows.
 *
 * ## Refused channels (§7.1, §11.3)
 * A channel the actor cannot read is refused as one that does not exist. The
 * readable channels are subscribed and acked with `subscribed` listing only
 * them; then ONE `error` (`not_found`, the refused ids in `details.channels`)
 * covers every refused one. With nothing readable, only the `error` is sent.
 * A `dm_…` target the caller is not a participant of is refused the same way.
 *
 * ## Subscription cap (§7.1)
 * All-or-nothing against {@link Config.wsMaxSubscriptions}: if subscribing
 * every readable listed channel not already subscribed would exceed the cap,
 * nothing is subscribed and a single `subscription_limit` (409) `error` is the
 * whole answer — no `subscribed`, no `not_found`. Only readable channels
 * count, so the limit error reveals nothing about unreadable ones.
 *
 * ## Resume (§7.1 "Resuming after a disconnect")
 * For each authorized channel with a `since` cursor we decode it to `sinceSeq`
 * and replay every message with `seq > sinceSeq`, in ascending `seq` order, as
 * a `message.created` event carrying the message's CURRENT canonical state (so
 * an edit/delete since the cursor is reflected in the replayed copy) and its
 * `cursor`. We register the subscription FIRST, then replay synchronously —
 * the single-process hub means no live event for that channel can interleave
 * ahead of the replay, so the client sees the gap-closing replay strictly
 * before live events. (At-least-once delivery, §7.1: the boundary message MAY
 * re-appear if the client already has it; clients de-dupe by message `id`.)
 *
 * ## Truncation
 * Replay is capped at {@link Config.maxResumeReplay}. If the gap exceeds the
 * cap (or the cursor predates retention), the channel is NOT replayed; instead
 * it is reported in the `subscribed` ack's `truncated` array so the client
 * backfills via REST history (§7.2).
 *
 * ## Known limitation (within §7.1 at-least-once + §8.5 REST-backfill)
 * The cursor space is REST-history (create) order, keyed on `seq`. Edits and
 * deletes to messages AT OR BEFORE the resume cursor are NOT individually
 * replayed (they carry the original message's `seq`, which is `<= sinceSeq`, so
 * `seq > sinceSeq` excludes them). A client reconciles such older edits/deletes
 * by re-reading REST history (§7.2). Only edits/deletes to post-cursor messages
 * are reflected here, via the message's current state in the replayed copy.
 * `include`/ephemeral events (typing, presence) are never replayed.
 */
export function handleSubscribe(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { config, db, hub, authority } = ctx;
  const parsed = WsSubscribeSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed subscribe command", frameId));
    return;
  }
  const hubConn = state.hubConn;
  if (!hubConn) return; // unreachable: only authenticated connections reach here

  const since = parsed.data.data.since;
  const authorized: string[] = [];
  const refused: string[] = [];
  // Authorized channels that carry a `since` cursor, paired with the channel's
  // groupId (needed to build the replayed `message.created` events).
  const resumable: { channelId: string; groupId: string; sinceCursor: string }[] = [];
  // Each listed channel once, in the order given.
  for (const channelId of new Set(parsed.data.data.channels)) {
    // A `dm_…` target is a DM subscription (§7.4). Delivery itself uses
    // `publishToActor`, so subscribing to a dm is an explicit opt-in/ack: we
    // authorize it iff the caller is a participant (has a `dm_conversations`
    // row). No resume/replay path for DMs in v0.1.
    if (channelId.startsWith("dm_")) {
      // A DM subscription acks against the caller's LOCAL inbox rows, which only
      // a local actor has; a remote participant's inbox lives at their own home
      // provider (DM delivery itself is `publishToActor`, not subscription-based).
      if (state.localHandle && isDmParticipant(db, state.localHandle, channelId, authority)) {
        authorized.push(channelId);
      } else {
        refused.push(channelId);
      }
      continue;
    }
    const row = getChannelRow(db, channelId);
    // Unknown channel or actor not permitted by tier/membership/view → refused
    // as not found (§11.3).
    if (row && canViewChannel(db, row, state.actor)) {
      authorized.push(channelId);
      const sinceCursor = since?.[channelId];
      if (sinceCursor !== undefined) {
        resumable.push({ channelId, groupId: row.groupId, sinceCursor });
      }
    } else {
      refused.push(channelId);
    }
  }

  // §7.1 subscription cap: all-or-nothing, counted over readable channels only.
  const added = new Set(authorized.filter((channelId) => !hubConn.subscriptions.has(channelId)));
  if (hubConn.subscriptions.size + added.size > config.wsMaxSubscriptions) {
    hub.send(
      ws,
      errorEvent(
        "subscription_limit",
        `subscribing would exceed this connection's limit of ${config.wsMaxSubscriptions} subscriptions`,
        frameId,
      ),
    );
    return;
  }

  const refusal = (): void => {
    if (refused.length === 0) return;
    hub.send(ws, errorEvent("not_found", "No such channel", frameId, { channels: refused }));
  };
  if (authorized.length === 0) {
    refusal();
    return;
  }

  // Register the subscriptions BEFORE replaying so the single-process hub never
  // interleaves a live event ahead of the replay for a resumed channel.
  hub.subscribe(hubConn, authorized);

  // Resolve each resumable channel to either a replay set or a truncation.
  const truncated: string[] = [];
  const replays: { channelId: string; groupId: string; records: MessageRecord[] }[] = [];
  for (const { channelId, groupId, sinceCursor } of resumable) {
    const sinceSeq = decodeMessageCursor(sinceCursor);
    // A forged/garbage cursor decodes to null; treat it as "no replay" rather
    // than replaying the whole channel from the start.
    if (sinceSeq == null) continue;
    const outcome = resumeMessages(db, channelId, sinceSeq, config.maxResumeReplay);
    if (outcome.truncated) {
      truncated.push(channelId);
    } else {
      replays.push({ channelId, groupId, records: outcome.messages });
    }
  }

  // Ack first (carrying `truncated` when non-empty), then the refusal, then
  // replay — the ack tells the client which channels to backfill via REST
  // before live events.
  hub.send(ws, {
    type: "subscribed",
    correlationId: frameId,
    data: {
      channels: authorized,
      ...(truncated.length > 0 ? { truncated } : {}),
    },
  });
  refusal();

  // Replay each non-truncated channel's post-cursor timeline, ascending, to
  // THIS connection only (a resume is private to the resuming client).
  for (const { channelId, groupId, records } of replays) {
    for (const record of records) {
      hub.send(ws, createdEvent(groupId, channelId, record, frameId));
    }
  }
}

/** §7.1: remove channels from the connection's set and ack `unsubscribed`. */
export function handleUnsubscribe(
  ctx: WsCtx,
  ws: WsContext,
  state: ConnState,
  rawFrame: unknown,
  frameId: string,
): void {
  const { hub } = ctx;
  const parsed = WsUnsubscribeSchema.safeParse(rawFrame);
  if (!parsed.success) {
    hub.send(ws, errorEvent("bad_request", "malformed unsubscribe command", frameId));
    return;
  }
  const hubConn = state.hubConn;
  if (!hubConn) return;
  const channels = parsed.data.data.channels;
  hub.unsubscribe(hubConn, channels);
  hub.send(ws, { type: "unsubscribed", correlationId: frameId, data: { channels } });
}
