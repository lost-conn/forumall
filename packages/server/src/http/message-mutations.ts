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
import { getChannelRow } from "../provider/channels.ts";
import { getMessageRow } from "../provider/messages.ts";
import { canActor } from "../provider/permissions.ts";

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
