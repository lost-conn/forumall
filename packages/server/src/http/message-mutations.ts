/**
 * Shared authorization for message create / edit / delete (spec §5.2.1, §7.1),
 * used identically by the WS commands (`http/ws/messages.ts`) and the REST
 * equivalents (`http/messages.ts`, via `http/message-create.ts` for creates):
 *
 *  - **create** (`message.create` / `POST …/messages`): {@link authorizePostAccess}
 *    (visibility 404, `post:<type>` + reply-only presence 403) before the
 *    duplicate lookup, {@link authorizeReplyTarget} (parent 400, `replyOnlyTo`
 *    403) after it.
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
import type { ChannelPermissions } from "@forumall/shared";

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
import type { RegistryErrorCode } from "./errors.ts";

/**
 * A structured failure: a §7.3 registry `errorCode` and a human message. The
 * HTTP status is NOT carried — it is fixed by the code (`errorCodeStatus`), so
 * the two cannot disagree.
 */
export interface MutationError {
  readonly code: RegistryErrorCode;
  readonly message: string;
}

/** Either the resolved message row (authorized) or a structured error. */
export type MutationOutcome =
  | { readonly error: MutationError; readonly row?: undefined }
  | { readonly error?: undefined; readonly row: MessageRow };

function notFound(): MutationOutcome {
  return { error: { code: "not_found", message: "no such message" } };
}

function forbidden(message: string): MutationOutcome {
  return { error: { code: "forbidden", message } };
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
 * What {@link authorizePostAccess} established about a poster: their role and
 * the channel's overrides, needed again by {@link authorizeReplyTarget}.
 */
export interface PostGrant {
  readonly role: string;
  readonly channelPermissions: ChannelPermissions | null;
}

/** Either the {@link PostGrant} (steps 2–3 passed) or a structured error. */
export type PostAccessOutcome =
  | { readonly error: MutationError; readonly grant?: undefined }
  | { readonly error?: undefined; readonly grant: PostGrant };

/**
 * Steps 2–3 of a create (§7.1 "Order of checks", shared by `message.create` and
 * `POST …/messages`) — the checks that depend only on the actor and the request,
 * so they also apply to a duplicate retry:
 *
 *  2. **Visibility:** the channel must exist in `groupId` and be readable by the
 *     actor ({@link canViewChannel}); otherwise `not_found` (404) — a missing
 *     and an unreadable channel get the same answer.
 *  3. **Permission:** the actor — a group member — must be permitted to post a
 *     message of `type` ({@link canPostKind}, falling back to the group `post`
 *     action), and a reply-restricted actor (§5.2.1 `replyOnly`) must supply a
 *     `reference`; otherwise `forbidden` (403).
 *
 * The parent check and `replyOnlyTo` need the parent message, so they are step
 * 5 ({@link authorizeReplyTarget}), applied to a new message only.
 */
export function authorizePostAccess(
  db: Db,
  groupId: string,
  channelId: string,
  actor: string,
  type: MessageKind,
  hasReference: boolean,
): PostAccessOutcome {
  const deny = (message: string): PostAccessOutcome => ({ error: { code: "forbidden", message } });

  const channel = getChannelRow(db, channelId);
  if (!channel || channel.groupId !== groupId || !canViewChannel(db, channel, actor)) {
    return { error: { code: "not_found", message: "no such channel" } };
  }

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
  if (!canPostKind(ctx, type)) {
    return deny(`not authorized to post ${type}s to this channel`);
  }
  if (isReplyRestricted(membership.role, channelPermissions) && !hasReference) {
    return deny("you may only post replies in this channel");
  }
  return { grant: { role: membership.role, channelPermissions } };
}

/**
 * Step 5 of a create (§7.1), for a new message only: a supplied `reference` must
 * be a reply (`type: "reply"`) whose `id` is a message in the same channel
 * (§7.2) — else `bad_request` (400) — and, for a reply-restricted actor with a
 * `replyOnlyTo` list, the parent's `type` must be listed — else `forbidden`
 * (403). Returns `null` when the reply target is acceptable (or there is none).
 */
export function authorizeReplyTarget(
  db: Db,
  channelId: string,
  grant: PostGrant,
  reference: { readonly type: string; readonly id: string } | undefined,
): MutationError | null {
  if (!reference) return null;
  if (reference.type !== "reply") {
    return { code: "bad_request", message: 'a message reference must have type "reply"' };
  }
  const parent: MessageRow | null = getMessageRow(db, channelId, reference.id);
  if (!parent) {
    return { code: "bad_request", message: "reply target not found in this channel" };
  }
  if (isReplyRestricted(grant.role, grant.channelPermissions)) {
    const allowedParentTypes = replyOnlyToTypes(grant.channelPermissions);
    if (allowedParentTypes && !allowedParentTypes.includes(parent.type)) {
      return {
        code: "forbidden",
        message: `replies in this channel must target a ${allowedParentTypes.join(" or ")}`,
      };
    }
  }
  return null;
}
