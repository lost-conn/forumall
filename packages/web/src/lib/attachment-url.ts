/**
 * The one way the UI turns an attachment into a URL to load or open.
 *
 * Attachment metadata is untrusted (§5.8), so the author's `url` is first held
 * to `http`/`https` ({@link attachmentFileUrl}); only then is the dev/test
 * scheme rewrite applied ({@link resolveAttachmentUrl}). Every element that
 * shows or links an attachment (`AttachmentView`, the lightbox, `attachment:`
 * links in a body) goes through here, so a `blob:`/`data:`/`javascript:` URL
 * can never reach an `<img>`, `<video>`, `<audio>` or `<a>`.
 */
import type { Attachment } from "@forumall/shared";
import { resolveAttachmentUrl } from "./chat-api.ts";
import { attachmentFileUrl } from "./content/links.ts";

/** The URL to show or open an attachment at, or `null` when it may not be used. */
export function attachmentUrl(attachment: Pick<Attachment, "url">): string | null {
  const url = attachmentFileUrl(attachment.url);
  return url === null ? null : resolveAttachmentUrl(url);
}
