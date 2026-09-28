/**
 * Ending live WebSocket access when read access is lost (reconciliation #15).
 *
 * OFSCP v0.1 §7.1 only says authorization is enforced *at subscription time*.
 * The Forumall/spec reconciliation's Spec PR 2 proposes the missing rule, which
 * this module implements ahead of standardisation:
 *
 *  - A provider MUST stop delivering a channel's events to a connection as soon
 *    as its actor may no longer read the channel, and SHOULD tell the connection
 *    with an unprompted `unsubscribed { channels, reason: "access_revoked" }`.
 *  - When the device key that authenticated a connection is revoked (§4.7), the
 *    provider MUST close the connection with `4003`.
 *
 * ## How
 *  1. **Hooks.** Every REST mutation that can reduce read access calls
 *     {@link revalidateGroupSubscriptions} / {@link revalidateChannelSubscriptions}
 *     after committing: member leave/kick, role change, ownership transfer, group
 *     update/deletion, channel update (tier / `permissions.view`) and channel
 *     deletion. It re-runs {@link canViewChannel} — the exact rule `subscribe`
 *     uses — for each live subscriber of the affected channels and revokes the
 *     ones that now fail. Local and remote (§8.5 direct-WS) subscribers are
 *     treated identically: both are keyed by their full `handle@domain` actor.
 *  2. **Delivery-time gate** ({@link channelDeliveryGate}), defence in depth for
 *     any path that forgets a hook: `publishToChannel` re-checks readability of
 *     non-public channels per subscriber (one channel-row read per event plus one
 *     indexed, prepared membership lookup per distinct subscribing actor —
 *     roughly 2ms per event for 1,000 subscribers; public-tier channels without
 *     a `view` override skip the check entirely). A subscriber that fails is
 *     revoked the same way.
 *  3. **Credential revocation** ({@link terminateKeySessions},
 *     {@link terminateHandleSessions}): device-key revocation, and guest
 *     claim/merge (which re-bind the key to a different actor), close the
 *     affected sockets with {@link WS_CLOSE_CREDENTIALS_REVOKED}. Remote actors'
 *     keys are re-validated periodically by the WS handler (`http/ws.ts`).
 */
import type { Db } from "../db/index.ts";
import type { ChannelRow } from "../db/schema.ts";
import {
  canViewChannel,
  canViewChannelWith,
  getChannelRow,
  listChannelRows,
  parseChannelPermissions,
} from "./channels.ts";
import { getGroupRow } from "./groups.ts";
import { isPublicTier } from "./tiers.ts";
import type { ChannelDeliveryGate, Hub, HubConnection } from "./ws-hub.ts";

/**
 * Close code for a connection whose credentials were revoked mid-session (the
 * device key it authenticated with was revoked, or re-bound to another actor).
 * v0.1 defines only `4001` (handshake failure); `4003` is the code Spec PR 2
 * proposes ("credentials revoked or access denied mid-session — do not retry
 * until re-authorized"), matching Antsome.
 */
export const WS_CLOSE_CREDENTIALS_REVOKED = 4003;

/**
 * Whether a channel is readable by anyone, so delivery needs no per-actor
 * check: both it and its group are public-tier (#24) and it has no `view`
 * override.
 */
function isOpenChannel(row: ChannelRow, groupTier: string | null): boolean {
  const viewRoles = parseChannelPermissions(row.permissions)?.view;
  return (
    groupTier != null &&
    isPublicTier(groupTier) &&
    isPublicTier(row.tier) &&
    !(viewRoles && viewRoles.length > 0)
  );
}

/**
 * Re-check every live subscription to `channelIds` against {@link canViewChannel}
 * and revoke those that fail (a channel that no longer exists fails for
 * everyone). Each affected connection receives ONE unprompted `unsubscribed`
 * listing all of its revoked channels. Call AFTER the mutation has committed.
 */
export function revalidateChannelSubscriptions(
  db: Db,
  hub: Hub,
  channelIds: Iterable<string>,
): void {
  const revoked = new Map<HubConnection, string[]>();
  for (const channelId of new Set(channelIds)) {
    const subscribers = hub.subscribersOf(channelId);
    if (subscribers.length === 0) continue;
    const row = getChannelRow(db, channelId);
    const verdicts = new Map<string, boolean>();
    for (const conn of subscribers) {
      let ok = verdicts.get(conn.actor);
      if (ok === undefined) {
        ok = row != null && canViewChannel(db, row, conn.actor);
        verdicts.set(conn.actor, ok);
      }
      if (!ok) {
        const list = revoked.get(conn) ?? [];
        list.push(channelId);
        revoked.set(conn, list);
      }
    }
  }
  for (const [conn, channels] of revoked) hub.revoke(conn, channels);
}

/**
 * {@link revalidateChannelSubscriptions} for every channel of `groupId`. Pass
 * `channelIds` explicitly when the group's channels are already gone (group
 * deletion — capture them before deleting).
 */
export function revalidateGroupSubscriptions(
  db: Db,
  hub: Hub,
  groupId: string,
  channelIds: Iterable<string> = listChannelRows(db, groupId).map((row) => row.id),
): void {
  revalidateChannelSubscriptions(db, hub, channelIds);
}

/**
 * The delivery-time gate `app.ts` installs on the hub (see module docs, point 2).
 * `dm_…` ids are passed through: DM delivery is per-actor (`publishToActor`) and
 * a DM "subscription" is only an acknowledged opt-in.
 */
export function channelDeliveryGate(db: Db): ChannelDeliveryGate {
  // This runs on every fan-out, so the membership lookup is a cached prepared
  // statement (a few µs) rather than a query-builder round (~20µs). The decision
  // itself is the shared `canViewChannelWith` rule body.
  const roleStmt = db.sqlite.query<{ role: string }, [string, string]>(
    "SELECT role FROM group_members WHERE group_id = ? AND user = ? LIMIT 1",
  );
  const roleOf = (groupId: string, actor: string): string | null =>
    roleStmt.get(groupId, actor)?.role ?? null;
  return (channelId) => {
    if (channelId.startsWith("dm_")) return null;
    const row = getChannelRow(db, channelId); // one read per event
    if (row == null) return () => false; // deleted: nobody may keep receiving it
    const groupTier = getGroupRow(db, row.groupId)?.tier ?? null;
    if (isOpenChannel(row, groupTier)) return null;
    return (actor) => canViewChannelWith(row, groupTier, actor, roleOf);
  };
}

/** Close every live connection that authenticated with local device key `keyId`. */
export function terminateKeySessions(hub: Hub, localHandle: string, keyId: string): number {
  return hub.terminateSessions(
    { localHandle, keyId },
    WS_CLOSE_CREDENTIALS_REVOKED,
    "device key revoked",
  );
}

/**
 * Close every live connection authenticated as local `localHandle` (any key) —
 * for identity changes that invalidate the actor a socket authenticated as
 * (guest claim renames it; guest merge deletes it).
 */
export function terminateHandleSessions(hub: Hub, localHandle: string, reason: string): number {
  return hub.terminateSessions({ localHandle }, WS_CLOSE_CREDENTIALS_REVOKED, reason);
}
