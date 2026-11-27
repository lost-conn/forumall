/**
 * Shared authorization for message create / edit / delete (spec §5.2.1, §7.1),
 * used identically by the WS commands (`http/ws/messages.ts`) and the REST
 * equivalents (`http/messages.ts`, via `http/message-create.ts` for creates):
 *
 *  - **create** (`message.create` / `POST …/messages`): {@link authorizePostAccess}
 *    (visibility 404, `post:<type>` + reply-only presence 403) before the
 *    duplicate lookup, {@link authorizeReplyTarget} (parent 400, `replyOnlyTo`
 *    403) after it.
 *  - **edit** (`message.update` / `PATCH …/messages/{id}`): a channel the
 *    actor cannot read, or a missing message → 404 (read access first, §11.3,
 *    so an author who lost access cannot edit and a non-reader cannot learn a
 *    message exists); then author-only, and only while `permissions.editUntil`
 *    (the row's `edit_until`) is in the future — with no limit when the
 *    message has none (§7.1); otherwise 403. The body is judged only after
 *    that (`http/message-edit.ts`).
 *  - **delete** (`message.delete` / `DELETE …/messages/{id}`): the same 404
 *    step; then the **author** OR a member with the `moderate` role; else 403.
 *  - **reactions** (`reaction.add`/`remove`, `PUT`/`DELETE …/reactions/{key}`):
 *    {@link authorizeReaction}.
 *
 * Every channel lookup goes through the §11.3 gate (`channel-access.ts`): a
 * channel the actor cannot read is answered exactly as a missing one.
 *
 * Each helper returns either `{ ok: true, row }` (the caller then mutates via the
 * `provider/messages.ts` store) or `{ error }` carrying the right status/code so
 * the WS path can build an `error` event and the REST path an {@link AppError}.
 */
import type { ChannelPermissions } from "@forumall/shared";

import type { Db } from "../db/index.ts";
import type { GroupRow, MessageRow } from "../db/schema.ts";
import { getReadableChannel, parseChannelPermissions } from "../provider/channels.ts";
import { isEditWindowOpen } from "../provider/edit-window.ts";
import { getGroupRow, rowToGroup } from "../provider/groups.ts";
import { getMessageRow } from "../provider/messages.ts";
import {
  type ChannelAuthzContext,
  type MessageKind,
  canActor,
  canPostKind,
  canReact,
  getMembership,
  isReplyRestricted,
  replyOnlyToTypes,
} from "../provider/permissions.ts";
import { CHANNEL_NOT_FOUND } from "./channel-access.ts";
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

function messageNotFound(): MutationOutcome {
  return { error: { code: "not_found", message: "no such message" } };
}

function channelNotFound(): MutationOutcome {
  return { error: CHANNEL_NOT_FOUND };
}

function forbidden(message: string): MutationOutcome {
  return { error: { code: "forbidden", message } };
}

/**
 * Resolve the target message for an edit or delete by `actor`: the channel must
 * exist in `groupId` and be readable by the actor (§11.3), and the message must
 * exist in it. Otherwise a 404 outcome — an unreadable channel answers exactly
 * as a missing one, before any author or `moderate` check.
 */
function resolveTarget(
  db: Db,
  groupId: string,
  channelId: string,
  messageId: string,
  actor: string,
): MutationOutcome {
  if (!getReadableChannel(db, channelId, actor, groupId)) return channelNotFound();
  const row = getMessageRow(db, channelId, messageId);
  if (!row) return messageNotFound();
  return { row };
}

/** A group's effective (defaults-filled) permission map, for channel authz. */
function groupPermissionsOf(groupRow: GroupRow): ChannelAuthzContext["groupPermissions"] {
  return rowToGroup(groupRow).permissions;
}

/**
 * Authorize an **edit** (§7.1): author-only and only while `edit_until` is in the
 * future (no limit when it is null). 404 if the message is missing; 403 if not
 * the author or the edit window has passed.
 */
export function authorizeMessageEdit(
  db: Db,
  groupId: string,
  channelId: string,
  messageId: string,
  actor: string,
): MutationOutcome {
  const resolved = resolveTarget(db, groupId, channelId, messageId, actor);
  if (resolved.error) return resolved;
  const row = resolved.row;
  if (row.author !== actor) return forbidden("only the author may edit this message");
  if (!isEditWindowOpen(row.editUntil)) {
    return forbidden("the edit window for this message has passed");
  }
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
  const resolved = resolveTarget(db, groupId, channelId, messageId, actor);
  if (resolved.error) return resolved;
  const row = resolved.row;
  const permitted = row.author === actor || canActor(db, "moderate", groupId, actor);
  if (!permitted) return forbidden("not authorized to delete this message");
  return { row };
}

/** Which reaction mutation is being authorized. */
export type ReactionAction = "add" | "remove";

/**
 * Authorize a **reaction add/remove** (§7.1 "Reactions", §5.2.1 `react`, §11):
 *
 *  1. the channel must exist in `groupId` and be readable by the actor
 *     (§11.3); otherwise `not_found` (404) — the same answer as a missing
 *     channel;
 *  2. **add only:** the actor must be a member of the group — reading a
 *     `public` channel never implies reacting in it (§11) — and permitted to
 *     react ({@link canReact}: the channel's `react` override by exact
 *     membership, else any member who can read); otherwise `forbidden` (403);
 *  3. the target message must exist in the channel; otherwise `not_found`.
 *
 * Removing is not gated on `react`, which "gates adding reactions" (§5.2.1):
 * an actor who can still read the channel may withdraw their own reaction (a
 * no-op when they hold none), e.g. after leaving the group or losing `react`.
 * Returns the target message row on success, keeping the
 * {@link MutationOutcome} contract uniform.
 */
export function authorizeReaction(
  db: Db,
  action: ReactionAction,
  groupId: string,
  channelId: string,
  messageId: string,
  actor: string,
): MutationOutcome {
  const channel = getReadableChannel(db, channelId, actor, groupId);
  if (!channel) return channelNotFound();
  if (action === "add") {
    const membership = getMembership(db, groupId, actor);
    const groupRow = getGroupRow(db, groupId);
    if (!membership || !groupRow) return forbidden("only group members may react in this channel");
    const ctx: ChannelAuthzContext = {
      role: membership.role,
      channelPermissions: parseChannelPermissions(channel.permissions),
      groupPermissions: groupPermissionsOf(groupRow),
    };
    if (!canReact(ctx)) return forbidden("not authorized to react in this channel");
  }
  const row = getMessageRow(db, channelId, messageId);
  if (!row) return messageNotFound();
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
 *     actor ({@link getReadableChannel}); otherwise `not_found` (404) — a
 *     missing and an unreadable channel get the same answer.
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

  const channel = getReadableChannel(db, channelId, actor, groupId);
  if (!channel) return { error: CHANNEL_NOT_FOUND };

  const membership = getMembership(db, groupId, actor);
  const groupRow = getGroupRow(db, groupId);
  if (!membership || !groupRow) return deny("not authorized to post to this channel");

  const channelPermissions = parseChannelPermissions(channel.permissions);
  const ctx: ChannelAuthzContext = {
    role: membership.role,
    channelPermissions,
    groupPermissions: groupPermissionsOf(groupRow),
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
