/**
 * The `400` rules a message create and an edit share (§5.3, §5.8, §7.1), for
 * the fields both carry: `attachments` (the §5.8 checks, in
 * `provider/message-attachments.ts`), `mentions` (canonical actors, §2.2) and
 * an article's `cover` (the `id` of one of its own `attachments`). The create
 * (`http/message-create.ts`, the DM delivery) and the edit
 * (`http/message-edit.ts`) both call these, so the same body is judged the same
 * way whichever carries it.
 */
import { type Attachment, type Message, isCanonicalActor } from "@forumall/shared";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { checkMessageAttachments } from "../provider/message-attachments.ts";
import type { MutationError } from "./message-mutations.ts";

/** A `bad_request` (400) {@link MutationError} with `message`. */
export function badRequestError(message: string): MutationError {
  return { code: "bad_request", message };
}

/**
 * The first schema issue of a rejected body as a short reason, e.g.
 * `invalid message body at attachments.0.url`.
 */
export function bodyIssue(
  what: string,
  issues: readonly { readonly path: readonly (string | number)[] }[],
): string {
  const issue = issues[0];
  const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return `invalid ${what}${where}`;
}

/**
 * The §5.8 checks on the `attachments` `author` is storing here: the list to
 * store (the provider's own record of each hosted upload; a remote author's
 * other attachments without `expiresAt`), or a `400`.
 */
export function checkAttachments(
  db: Db,
  config: Config,
  author: string,
  attachments: readonly Attachment[],
): { readonly error: MutationError } | { readonly error?: undefined; attachments: Attachment[] } {
  const outcome = checkMessageAttachments(db, config, author, attachments);
  if (outcome.error !== undefined) return { error: badRequestError(outcome.error) };
  return { attachments: outcome.attachments };
}

/**
 * §5.3 *Mentions*: every entry must be an actor in canonical form (§2.2). This
 * provider rejects rather than converts, as for every other actor field
 * (`http/canonical-fields.ts`). `null` when all entries are canonical.
 */
export function mentionsError(mentions: readonly string[]): MutationError | null {
  const index = mentions.findIndex((m) => !isCanonicalActor(m));
  if (index === -1) return null;
  return badRequestError(
    `mentions[${index}] must be a canonical actor (handle@domain, OFSCP §2.2)`,
  );
}

/**
 * §5.3: an article whose `cover` is not the `id` of one of its `attachments`
 * is a `400`, for a create and for the result of an edit. `null` when the cover
 * is absent or names an attachment.
 */
export function coverError(
  cover: string | null | undefined,
  attachments: readonly Attachment[],
): MutationError | null {
  if (cover == null || attachments.some((a) => a.id === cover)) return null;
  return badRequestError("cover must be the id of one of the message's attachments");
}

/** The article fields of a message (§5.3); each `undefined` when absent. */
export interface ArticleFields {
  readonly title?: string;
  readonly summary?: string;
  readonly cover?: string;
}

/** The checked fields of a create, ready to store. */
export interface CheckedCreateFields {
  readonly attachments: Attachment[];
  readonly mentions?: string[];
  /** Empty unless `type` is `article`: the fields are ignored on other types. */
  readonly article: ArticleFields;
}

/**
 * The create's shared field rules: the §5.8 attachment checks, canonical
 * `mentions`, and for an `article` its fields with a `cover` that names one of
 * the checked attachments. The article fields of any other type are ignored
 * (§5.3), so they are neither checked nor stored.
 */
export function checkCreateFields(
  db: Db,
  config: Config,
  author: string,
  type: Message["type"],
  body: {
    readonly attachments?: readonly Attachment[] | undefined;
    readonly mentions?: readonly string[] | undefined;
    readonly title?: string | undefined;
    readonly summary?: string | undefined;
    readonly cover?: string | undefined;
  },
): { readonly error: MutationError } | { readonly error?: undefined; fields: CheckedCreateFields } {
  const checked = checkAttachments(db, config, author, body.attachments ?? []);
  if (checked.error) return { error: checked.error };
  if (body.mentions !== undefined) {
    const error = mentionsError(body.mentions);
    if (error) return { error };
  }
  let article: ArticleFields = {};
  if (type === "article") {
    const error = coverError(body.cover, checked.attachments);
    if (error) return { error };
    article = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.cover !== undefined ? { cover: body.cover } : {}),
    };
  }
  return {
    fields: {
      attachments: checked.attachments,
      ...(body.mentions !== undefined ? { mentions: [...body.mentions] } : {}),
      article,
    },
  };
}
