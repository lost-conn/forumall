/**
 * Keeping the local sent store (`lib/dm-store.ts`, §8.3) in step with the
 * server's copies of the caller's own DM messages.
 *
 * The sent store is what a reload shows of a message the caller wrote: the
 * caller's history never returns it (it lives in the recipient's inbox), so a
 * server copy seen live (`dm.message`: the confirmation of an edit, an edit or
 * delete from another device) or on a page (a self/same-node DM's history, a
 * replies page) is merged into it by the shared version rules, and an older
 * copy changes nothing.
 *
 * While a mutation of the message is unsettled (`dm-mutation-chain.ts`) the
 * entry holds the user's latest edit or delete, which a server copy must not
 * replace: the thread keeps that copy aside (`DmMessage.serverCopy`) and the
 * mutation's settle installs the winner in both stores.
 */
import type { Message } from "@forumall/shared";
import type { DmSentStore } from "../../lib/dm-store.ts";
import { hasUnsettledDmMutation } from "./dm-mutation-chain.ts";

/** The fields of a server copy the sent store keeps. */
export type DmServerCopy = Pick<
  Message,
  "id" | "author" | "content" | "createdAt" | "attachments" | "reference" | "editedAt" | "deletedAt"
>;

/** Merge a server copy of a DM message into the sent store, if `me` wrote it. */
export function retainServerCopy(
  sentStore: DmSentStore,
  dmId: string,
  me: string,
  copy: DmServerCopy,
): void {
  if (copy.author !== me || hasUnsettledDmMutation(dmId, copy.id)) return;
  const deleted = copy.deletedAt !== undefined;
  sentStore.mergeCopy(dmId, {
    id: copy.id,
    author: copy.author,
    createdAt: copy.createdAt,
    content: deleted ? { mime: "text/plain", text: "" } : copy.content,
    ...(!deleted && copy.attachments && copy.attachments.length > 0
      ? { attachments: copy.attachments }
      : {}),
    ...(!deleted && copy.reference ? { reference: copy.reference } : {}),
    ...(copy.editedAt !== undefined ? { editedAt: copy.editedAt } : {}),
    ...(deleted ? { deletedAt: copy.deletedAt } : {}),
  });
}
