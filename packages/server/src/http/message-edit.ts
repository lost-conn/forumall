/**
 * §7.1 *Editing*: turn a `MessageUpdate` body into the change to store, for
 * every edit path — WS `message.update`, `PATCH …/channels/{channelId}/messages/{id}`,
 * `PATCH /api/dms/{dmId}/messages/{id}` and the federation DM PATCH (§7.4,
 * §8.3). Each caller runs it only after the edit is authorized (the message
 * exists → else 404; the actor is its author and the edit window is open →
 * else 403), so a non-author or a missing message is never told about its
 * body.
 *
 * Each field present replaces the stored value; each absent field is kept:
 *  - `content`, `tags`, `mentions` and `attachments` (in full). `attachments`
 *    gets the same §5.8 checks as a create (`http/message-fields.ts`), and
 *    `mentions` the same §2.2 check.
 *  - `title`, `summary` and `cover` on an `article`, where `null` removes the
 *    field. On any other type they are ignored and do not count towards the
 *    one field an edit needs.
 *  - `type`, `reference` and `metadata` cannot be edited and are ignored.
 *
 * `400` (`bad_request`) when the body does not match `MessageUpdate` (which
 * includes carrying none of its fields), when a non-article edit carries only
 * article fields, when a field breaks a create's rule, or when the result
 * leaves an article's `cover` naming none of its `attachments`.
 *
 * This provider does not track which messages reference an upload, so an edit
 * that drops an attachment changes nothing about the upload (§5.8 *Revocation*
 * is a SHOULD; see CONFORMANCE.md).
 */
import {
  type Attachment,
  MESSAGE_UPDATE_FIELDS,
  type Message,
  MessageUpdateRequestSchema,
} from "@forumall/shared";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import {
  type MessageFieldsUpdate,
  type MessageRecord,
  updateMessageFields,
} from "../provider/messages.ts";
import {
  badRequestError,
  bodyIssue,
  checkAttachments,
  coverError,
  mentionsError,
} from "./message-fields.ts";
import { type MutationError, authorizeMessageEdit } from "./message-mutations.ts";

/** The stored message an edit applies to: what its rules depend on. */
export interface EditTarget {
  readonly type: Message["type"];
  readonly attachments: readonly Attachment[];
  /** The stored article `cover`, or `null`. */
  readonly cover: string | null;
}

/** The article fields of a `MessageUpdate`. */
const ARTICLE_FIELDS = ["title", "summary", "cover"] as const;

/** The edit's change to store, or why it is a `400`. */
export type MessageEditOutcome =
  | { readonly error: MutationError; readonly patch?: undefined }
  | { readonly error?: undefined; readonly patch: MessageFieldsUpdate };

/**
 * Check `body` as `author`'s edit of `target` and return the change to store
 * (see the module doc). Call only after the edit is authorized.
 */
export function resolveMessageEdit(
  db: Db,
  config: Config,
  author: string,
  target: EditTarget,
  body: unknown,
): MessageEditOutcome {
  const parsed = MessageUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { error: badRequestError(bodyIssue("edit body", parsed.error.issues)) };
  }
  const update = parsed.data;
  const article = target.type === "article";

  // Article fields are ignored on other types and do not count as the one
  // field an edit needs there.
  if (!article) {
    const editable = MESSAGE_UPDATE_FIELDS.filter(
      (f) => !(ARTICLE_FIELDS as readonly string[]).includes(f),
    );
    if (!editable.some((f) => update[f] !== undefined)) {
      return {
        error: badRequestError(
          `an edit of a non-article message must carry at least one of: ${editable.join(", ")}`,
        ),
      };
    }
  }

  let attachments: Attachment[] | undefined;
  if (update.attachments !== undefined) {
    const checked = checkAttachments(db, config, author, update.attachments);
    if (checked.error) return { error: checked.error };
    attachments = checked.attachments;
  }
  if (update.mentions !== undefined) {
    const error = mentionsError(update.mentions);
    if (error) return { error };
  }
  if (article) {
    const cover = update.cover !== undefined ? update.cover : target.cover;
    const error = coverError(cover, attachments ?? target.attachments);
    if (error) return { error };
  }

  return {
    patch: {
      ...(update.content !== undefined ? { content: update.content } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(update.tags !== undefined ? { tags: update.tags } : {}),
      ...(update.mentions !== undefined ? { mentions: update.mentions } : {}),
      ...(article && update.title !== undefined ? { title: update.title } : {}),
      ...(article && update.summary !== undefined ? { summary: update.summary } : {}),
      ...(article && update.cover !== undefined ? { cover: update.cover } : {}),
    },
  };
}

/** A channel message edit: the target, the authenticated actor and the raw body. */
export interface ChannelEditInput {
  readonly groupId: string;
  readonly channelId: string;
  readonly messageId: string;
  /** The authenticated actor. */
  readonly actor: string;
  /** The `MessageUpdate` body as received (WS `data` also carries the ids). */
  readonly body: unknown;
}

/**
 * Edit a channel message (WS `message.update` and `PATCH …/messages/{id}`) in
 * the order of §7.1 *Edits and deletes of a tombstone*: a body that is not a
 * JSON object is `400` before anything else (step 1; REST passes `undefined`
 * for a body that is not JSON at all); then authorize (404 hidden channel,
 * missing message, tombstone, wrong channel or group; 403 not the author or the
 * edit window has passed), then {@link resolveMessageEdit} (400), then store.
 * The caller fans out `message.updated` with the returned record.
 */
export function editChannelMessage(
  db: Db,
  config: Config,
  input: ChannelEditInput,
): { readonly error: MutationError } | { readonly error?: undefined; record: MessageRecord } {
  const { groupId, channelId, messageId, actor } = input;
  if (!isJsonObject(input.body)) {
    return { error: badRequestError("edit body must be a JSON object") };
  }
  const outcome = authorizeMessageEdit(db, groupId, channelId, messageId, actor);
  if (outcome.error) return { error: outcome.error };
  const row = outcome.row;
  const target: EditTarget = {
    type: row.type as Message["type"],
    attachments: JSON.parse(row.attachments) as Attachment[],
    cover: row.cover,
  };
  const edit = resolveMessageEdit(db, config, actor, target, input.body);
  if (edit.error) return { error: edit.error };
  return { record: updateMessageFields(db, channelId, messageId, edit.patch) };
}

/** A JSON object: not `null`, an array, a primitive or `undefined` (no JSON body). */
function isJsonObject(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}
