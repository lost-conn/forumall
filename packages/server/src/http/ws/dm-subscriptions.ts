/**
 * `dmId` subscriptions (§7.4 "Real-time", §8.5): who may subscribe to a `dm_…`
 * target, and its `since` resume replay. `subscriptions.ts` calls these for
 * every `dm_…` target of a `subscribe`.
 *
 * DM delivery to an actor's own inbox is implicit (no subscription needed). A
 * `dmId` subscription adds what implicit delivery cannot reach: the events of
 * the messages the subscriber SENT that this provider holds in the
 * counterparty's inbox — their `dm.message` (create, and edits/deletes re-sent
 * as `dm.message`) and the `dm.reaction`s on them. That is how a participant
 * on another provider, connected here directly (§8.5), follows their sent
 * messages; the fan-out itself is `publishDmMessage` / `fanOutDmReaction` in
 * `dm-events.ts`.
 */
import type { Config } from "../../config.ts";
import type { Db } from "../../db/index.ts";
import { resumeDmMessages } from "../../provider/dm-history.ts";
import { type DmMessageRecord, isDmParticipant } from "../../provider/dms.ts";
import { decodeMessageCursor } from "../../provider/messages.ts";
import type { OutboundEvent } from "../../provider/ws-hub.ts";
import { dmMessageEventData } from "../dm-events.ts";
import { resolveLocalDmOwner } from "../dm-request.ts";
import type { ConnState } from "./connection.ts";

/**
 * Whether the connection's actor may subscribe to `dmId`: it is a participant
 * of the conversation. §7.4 defines that as "`{dmId}` equals the id derived
 * from the actor and one of the provider's local users" — which holds for a
 * remote or local actor alike, with or without any message or pointer yet. A
 * LOCAL actor whose counterparty is on another provider is a participant too,
 * but the one-way `dmId` names no local user then; their consistent
 * conversation row (an inbox message or a pointer) is what proves it.
 *
 * Anyone else is refused exactly as an unknown target is (`not_found`), so a
 * subscribe reveals nothing about conversations between other users.
 */
export function mayFollowDm(
  db: Db,
  config: Config,
  authority: string,
  state: Pick<ConnState, "actor" | "localHandle">,
  dmId: string,
): boolean {
  if (state.actor === undefined) return false;
  if (state.localHandle !== undefined && isDmParticipant(db, state.localHandle, dmId, authority)) {
    return true;
  }
  return resolveLocalDmOwner(db, config, state.actor, dmId) !== null;
}

/** What a `dmId` resume resolves to: replay these records, or report truncation. */
export type DmReplay =
  | { readonly kind: "replay"; readonly records: DmMessageRecord[] }
  | { readonly kind: "truncated" }
  | { readonly kind: "none" };

/**
 * Resolve the `since` cursor of a `dmId` subscription to its replay (§7.4: "as
 * for a channel", §7.1): the subscriber's view of the conversation — the
 * `GET /api/dms/{dmId}/messages` rows — after the cursor, or `truncated` when
 * the gap exceeds `config.maxResumeReplay`. A cursor that does not decode is no
 * replay at all, never a replay from the start.
 */
export function resolveDmReplay(
  db: Db,
  config: Config,
  state: Pick<ConnState, "actor" | "localHandle">,
  dmId: string,
  sinceCursor: string,
): DmReplay {
  const sinceSeq = decodeMessageCursor(sinceCursor);
  if (sinceSeq == null || state.actor === undefined) return { kind: "none" };
  const viewer = {
    actor: state.actor,
    ...(state.localHandle !== undefined ? { localHandle: state.localHandle } : {}),
  };
  const outcome = resumeDmMessages(db, dmId, viewer, sinceSeq, config.maxResumeReplay);
  return outcome.truncated ? { kind: "truncated" } : { kind: "replay", records: outcome.records };
}

/** A replayed `dm.message` (current state + cursor), correlated to the `subscribe`. */
export function dmReplayEvent(
  dmId: string,
  record: DmMessageRecord,
  correlationId: string,
): OutboundEvent {
  return {
    type: "dm.message",
    correlationId,
    data: dmMessageEventData(dmId, record.cursor, record.message),
  };
}
