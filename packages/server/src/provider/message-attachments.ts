/**
 * §5.8 "Checks on attachments in a message": what the provider that stores a
 * message does with each `Attachment` it carries. Shared by every path that
 * stores attachments — the channel create (`message.create` / `POST
 * …/messages`, §7.1), the DM delivery (§7.4, §8.3) and every edit that
 * replaces `attachments` (§7.1) — so a create and an edit are checked alike.
 *
 *  - An attachment this provider **hosts** (its `POST /api/media` issued it) is
 *    checked against the stored upload: the `id` is a stored upload, the
 *    message's author uploaded it, and `mime`, `size` and `hash` equal the
 *    stored values. The message keeps the provider's own record of it, not the
 *    client's copy of the optional fields.
 *  - A **local** author's attachments must all be hosted here: local users
 *    upload to their home provider (§5.8 *Where to upload*).
 *  - An attachment from a **remote** author that this provider does not host
 *    must use `https` for `url` and `thumbnail.url` (the shared schema already
 *    enforces both, and that a thumbnail carries no thumbnail), and loses any
 *    `expiresAt` the author supplied, on it or its thumbnail: only the provider
 *    that mints a short-lived URL sets `expiresAt` (§5.8 *Revocation*). The URL
 *    is never fetched.
 *
 * Uploads here have no `target` yet (every upload is a local one) and this
 * provider mints no short-lived URLs, so no stored attachment carries
 * `expiresAt`.
 */
import { type Attachment, canonicalAuthority } from "@forumall/shared";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { getMediaRow, hostedMediaRowForUrl, mediaUrl, rowToAttachment } from "./media.ts";

/** The checked attachments to store, or why the message is a 400. */
export type AttachmentCheckOutcome =
  | { readonly error: string; readonly attachments?: undefined }
  | { readonly error?: undefined; readonly attachments: Attachment[] };

/** Whether `url` names this provider's media endpoint (a URL it would issue). */
function isHostedUrl(config: Config, url: string): boolean {
  return url.startsWith(mediaUrl(config, ""));
}

/** Whether `actor` (`handle@domain`) is a user of this provider. */
function isLocalAuthor(config: Config, actor: string): boolean {
  const at = actor.lastIndexOf("@");
  return at > 0 && canonicalAuthority(actor.slice(at + 1)) === canonicalAuthority(config.domain);
}

/** `attachment` without an author-supplied `expiresAt`, on it or its thumbnail. */
function withoutExpiresAt(attachment: Attachment): Attachment {
  const { expiresAt: _dropped, thumbnail, ...rest } = attachment;
  if (thumbnail === undefined) return rest;
  const { expiresAt: _droppedThumb, ...thumb } = thumbnail;
  return { ...rest, thumbnail: thumb };
}

/**
 * Run the §5.8 checks on the `attachments` of a message `author` is storing
 * here (see the module doc). Returns the list to store, in order, or the
 * reason for a `400`.
 */
export function checkMessageAttachments(
  db: Db,
  config: Config,
  author: string,
  attachments: readonly Attachment[],
): AttachmentCheckOutcome {
  const local = isLocalAuthor(config, author);
  const checked: Attachment[] = [];
  for (const [i, attachment] of attachments.entries()) {
    const where = `attachments[${i}]`;
    const row = getMediaRow(db, attachment.id) ?? hostedMediaRowForUrl(db, config, attachment.url);
    const claimsHosted = row !== null || isHostedUrl(config, attachment.url);
    if (claimsHosted) {
      if (row === null || row.id !== attachment.id) {
        return { error: `${where}: not an upload on this provider` };
      }
      if (row.owner !== author) {
        return { error: `${where}: uploaded by another user` };
      }
      if (
        attachment.mime !== row.mime ||
        attachment.size !== row.size ||
        attachment.hash !== row.hash
      ) {
        return { error: `${where}: mime, size or hash differs from the stored upload` };
      }
      checked.push(rowToAttachment(config, row));
      continue;
    }
    if (local) {
      return {
        error: `${where}: not hosted here; upload attachments to your home provider (POST /api/media)`,
      };
    }
    checked.push(withoutExpiresAt(attachment));
  }
  return { attachments: checked };
}
