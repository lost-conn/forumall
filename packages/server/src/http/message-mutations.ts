/**
 * Shared authorization for message edit / delete (spec §7.1 "Editing & deleting
 * messages"), used identically by the WS commands (`http/ws.ts`) and the REST
 * equivalents (`http/messages.ts`):
 *
 *  - **edit** (`message.update` / `PATCH …/messages/{id}`): author-only, and only
 *    while `permissions.editUntil` (the row's `edit_until`) is in the future;
 *    otherwise 403. A missing message (or wrong channel/group) → 404.
 *  - **delete** (`message.delete` / `DELETE …/messages/{id}`): the **author** OR
 *    a member with the `moderate` role; otherwise 403. Missing → 404.
 *
 * Each helper returns either `{ ok: true, row }` (the caller then mutates via the
 * `provider/messages.ts` store) or `{ error }` carrying the right status/code so
 * the WS path can build an `error` event and the REST path an {@link AppError}.
 */
import type { Db } from "../db/index.ts";
import type { MessageRow } from "../db/schema.ts";
import { canViewChannel, getChannelRow, parseChannelPermissions } from "../provider/channels.ts";
import { getGroupRow, rowToGroup } from "../provider/groups.ts";
import { getMessageRow } from "../provider/messages.ts";
import {
  type ChannelAuthzContext,
  type MessageKind,
  canActor,
  canPostKind,
  getMembership,
  isReplyRestricted,
  replyOnlyToTypes,
  roleMeets,
} from "../provider/permissions.ts";

/** A structured failure: a stable code, human message, and HTTP status. */
export interface MutationError {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

/** Either the resolved message row (authorized) or a structured error. */
export type MutationOutcome =
  | { readonly error: MutationError; readonly row?: undefined }
  | { readonly error?: undefined; readonly row: MessageRow };

function notFound(): MutationOutcome {
  return { error: { code: "not_found", message: "no such message", status: 404 } };
}

function forbidden(message: string): MutationOutcome {
  return { error: { code: "forbidden", message, status: 403 } };
}

/**
 * Resolve the target message + verify it belongs to `groupId`/`channelId`.
 * Returns the row, or a 404 outcome if it does not exist / is in another
 * channel-or-group.
 */
function resolveTarget(
  db: Db,
  groupId: string,
  channelId: string,
  messageId: string,
): MutationOutcome {
  const channel = getChannelRow(db, channelId);
  if (!channel || channel.groupId !== groupId) return notFound();
  const row = getMessageRow(db, channelId, messageId);
  if (!row) return notFound();
  return { row };
}

/**
 * Authorize an **edit** (§7.1): author-only and only while `edit_until` is in the
 * future. 404 if the message is missing; 403 if not the author or the edit window
 * has passed.
 */
export function authorizeMessageEdit(
  db: Db,
  groupId: string,
  channelId: string,
  messageId: string,
  actor: string,
): MutationOutcome {
  const resolved = resolveTarget(db, groupId, channelId, messageId);
  if (resolved.error) return resolved;
  const row = resolved.row;
  if (row.author !== actor) return forbidden("only the author may edit this message");
  if (Date.now() >= row.editUntil) return forbidden("the edit window for this message has passed");
  return { row };
}

/**
 * Authorize a **delete** (§7.1): the author OR a member holding the `moderate`
 * role may tombstone. 404 if missing; 403 otherwise.
 */
export function authorizeMessageDelete(
  db: Db,
  groupId: string,
  channelId: string,
  messageId: string,
  actor: string,
): MutationOutcome {
  const resolved = resolveTarget(db, groupId, channelId, messageId);
  if (resolved.error) return resolved;
  const row = resolved.row;
  const permitted = row.author === actor || canActor(db, "moderate", groupId, actor);
  if (!permitted) return forbidden("not authorized to delete this message");
  return { row };
}

/**
 * Authorize a **reaction add/remove** (§7.1 "Reactions"): the actor must be able
 * to SEE the channel (tier + membership, via {@link channelVisibleTo}) and the
 * target message must exist in that channel/group. There is no per-key
 * permission gate — any actor who can read the channel may react. 404 if the
 * channel/message is missing (or in another group); 403 if the actor cannot see
 * the channel. Returns the target message row on success (callers don't need it,
 * but it keeps the {@link MutationOutcome} contract uniform).
 *
 * Note 404 (missing) precedes the 403 visibility check only for an *existing but
 * hidden* channel: an unknown channel is 404 regardless of caller, a known
 * private channel the actor can't see is 403, mirroring the message-history read.
 */
export function authorizeReaction(
  db: Db,
  groupId: string,
  channelId: string,
  messageId: string,
  actor: string,
): MutationOutcome {
  const channel = getChannelRow(db, channelId);
  if (!channel || channel.groupId !== groupId) return notFound();
  if (!canViewChannel(db, channel, actor)) {
    return forbidden("not authorized to react in this channel");
  }
  // Per-channel `react` override (§5.2.1): when present, gate on it (rank-
  // inherited). When absent, any actor who can read the channel may react —
  // the v0.1 default — so we add no extra bar.
  const channelPerms = parseChannelPermissions(channel.permissions);
  if (channelPerms?.react && channelPerms.react.length > 0) {
    const membership = getMembership(db, groupId, actor);
    if (!membership || !roleMeets(membership.role, channelPerms.react)) {
      return forbidden("not authorized to react in this channel");
    }
  }
  const row = getMessageRow(db, channelId, messageId);
  if (!row) return notFound();
  return { row };
}

/**
 * Authorize a **post** (`message.create`, §5.2.1): the channel must exist in
 * `groupId`, be readable by the actor ({@link canViewChannel}), and the actor —
 * a group member — must be permitted to post a message of `type` there
 * ({@link canPostKind}, falling back to the group `post` action). Reply
 * qualification (`replyOnly` / `replyOnlyTo`) is enforced here too: a
 * reply-restricted actor MUST supply a `reference`, and when `replyOnlyTo` is set
 * the referenced parent's `type` must be allowed. A supplied `reference` MUST
 * resolve to a message in the same channel (§7.2).
 *
 * Returns `null` when authorized, or a {@link MutationError}. Existence failures
 * surface as `forbidden` (403) — like the prior single-boolean gate — so posting
 * never leaks channel existence beyond what `subscribe` already does. A bad
 * reply target is a `bad_request` (400).
 */
export function authorizeChannelPost(
  db: Db,
  groupId: string,
  channelId: string,
  actor: string,
  type: MessageKind,
  reference: { readonly type: string; readonly id: string } | undefined,
): MutationError | null {
  const deny = (message: string): MutationError => ({ code: "forbidden", message, status: 403 });

  const channel = getChannelRow(db, channelId);
  if (!channel || channel.groupId !== groupId)
    return deny("not authorized to post to this channel");
  if (!canViewChannel(db, channel, actor)) return deny("not authorized to post to this channel");

  const membership = getMembership(db, groupId, actor);
  const groupRow = getGroupRow(db, groupId);
  if (!membership || !groupRow) return deny("not authorized to post to this channel");

  const channelPermissions = parseChannelPermissions(channel.permissions);
  const ctx: ChannelAuthzContext = {
    role: membership.role,
    channelPermissions,
    groupPermissions: rowToGroup(groupRow).permissions as Record<
      string,
      readonly string[] | undefined
    >,
  };

  // A reply target must resolve to a message in this same channel (§7.2).
  let parent: MessageRow | null = null;
  if (reference) {
    parent = getMessageRow(db, channelId, reference.id);
    if (!parent) {
      return {
        code: "bad_request",
        message: "reply target not found in this channel",
        status: 400,
      };
    }
  }

  if (!canPostKind(ctx, type)) {
    return deny(`not authorized to post ${type}s to this channel`);
  }

  // Reply qualification (§5.2.1).
  if (isReplyRestricted(membership.role, channelPermissions)) {
    if (!reference || !parent) {
      return deny("you may only post replies in this channel");
    }
    const allowedParentTypes = replyOnlyToTypes(channelPermissions);
    if (allowedParentTypes && !allowedParentTypes.includes(parent.type)) {
      return deny(`replies in this channel must target a ${allowedParentTypes.join(" or ")}`);
    }
  }

  return null;
}
