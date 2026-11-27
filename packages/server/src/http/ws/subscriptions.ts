/**
 * §7.1 Subscriptions: `subscribe` (with per-channel authorization and `since`
 * resume replay) and `unsubscribe`.
 */
import { WsSubscribeSchema, WsUnsubscribeSchema } from "@forumall/shared";
import { canViewChannel, getChannelRow } from "../../provider/channels.ts";
import type { DmMessageRecord } from "../../provider/dms.ts";
import {
  type MessageRecord,
  decodeMessageCursor,
  resumeMessages,
} from "../../provider/messages.ts";
import type { OutboundEvent } from "../../provider/ws-hub.ts";
import { createdEvent } from "../message-create.ts";
import { type ConnState, type WsContext, type WsCtx, errorEvent } from "./connection.ts";
import { dmReplayEvent, mayFollowDm, resolveDmReplay } from "./dm-subscriptions.ts";

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
 *
 * ## `dmId` targets (§7.4 "Real-time", §8.5)
 * A `dm_…` target is accepted iff the actor — local, or remote over a direct
 * connection — is a participant ({@link mayFollowDm}); anyone else is refused
 * in that same `not_found`, exactly as an unknown `dmId` is. It counts toward
 * the cap like a channel, and its `since` resumes in the DM cursor space
 * ({@link resolveDmReplay}): the subscriber's `GET /api/dms/{dmId}/messages`
 * rows after the cursor, replayed as `dm.message`, or reported `truncated`.
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
  // Authorized targets that carry a `since` cursor: a channel (with its groupId,
  // needed to build the replayed `message.created` events) or a `dmId`.
  const resumable: ({ channelId: string; sinceCursor: string } & (
    | { kind: "channel"; groupId: string }
    | { kind: "dm" }
  ))[] = [];
  // Each listed channel once, in the order given.
  for (const channelId of new Set(parsed.data.data.channels)) {
    if (channelId.startsWith("dm_")) {
      if (mayFollowDm(db, config, authority, state, channelId)) {
        authorized.push(channelId);
        const sinceCursor = since?.[channelId];
        if (sinceCursor !== undefined) resumable.push({ kind: "dm", channelId, sinceCursor });
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
        resumable.push({ kind: "channel", channelId, groupId: row.groupId, sinceCursor });
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

  // Resolve each resumable target to either a replay (its events, in order) or
  // a truncation.
  const truncated: string[] = [];
  const replays: OutboundEvent[][] = [];
  for (const target of resumable) {
    if (target.kind === "dm") {
      const replay = resolveDmReplay(db, config, state, target.channelId, target.sinceCursor);
      if (replay.kind === "truncated") truncated.push(target.channelId);
      if (replay.kind === "replay") {
        replays.push(
          replay.records.map((r: DmMessageRecord) => dmReplayEvent(target.channelId, r, frameId)),
        );
      }
      continue;
    }
    const sinceSeq = decodeMessageCursor(target.sinceCursor);
    // A forged/garbage cursor decodes to null; treat it as "no replay" rather
    // than replaying the whole channel from the start.
    if (sinceSeq == null) continue;
    const outcome = resumeMessages(db, target.channelId, sinceSeq, config.maxResumeReplay);
    if (outcome.truncated) {
      truncated.push(target.channelId);
    } else {
      replays.push(
        outcome.messages.map((record: MessageRecord) =>
          createdEvent(target.groupId, target.channelId, record, frameId),
        ),
      );
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

  // Replay each non-truncated target's post-cursor timeline, ascending, to
  // THIS connection only (a resume is private to the resuming client).
  for (const events of replays) {
    for (const event of events) hub.send(ws, event);
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
