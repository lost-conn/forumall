/**
 * Edit and delete of a stored inbox DM (§7.1 rules applied to the recipient's
 * copy, §7.4, §8.3). The HTTP layer (`http/dm-events.ts`) authorizes and checks
 * the edit first; these only write the row and return the updated record.
 */
import type { Content } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { dmMessages } from "../db/schema.ts";
import { type DmMessageRecord, getDmMessageRow, toDmRecord } from "./dms.ts";
import { type MessageFieldsUpdate, editedJsonColumns } from "./messages.ts";

/** The cleared content a tombstone carries (mirrors `provider/messages.ts`). */
const TOMBSTONE_CONTENT: Content = { text: "", mime: "text/plain" };

/** The `WHERE` for one inbox row. */
function inboxRow(owner: string, dmId: string, messageId: string) {
  return and(eq(dmMessages.owner, owner), eq(dmMessages.dmId, dmId), eq(dmMessages.id, messageId));
}

/**
 * Apply an edit to an inbox DM (§7.1): replace each of `content`,
 * `attachments`, `tags` and `mentions` that `update` carries and stamp
 * `edited_at = now`. A DM is never an `article`, so the article fields are not
 * stored. The caller is responsible for authorization (author-only), the
 * edit-window check and the field rules BEFORE calling. Returns the updated
 * record. Throws if the row is absent.
 */
export function updateDmMessageFields(
  db: Db,
  owner: string,
  dmId: string,
  messageId: string,
  update: MessageFieldsUpdate,
): DmMessageRecord {
  db.drizzle
    .update(dmMessages)
    .set({ ...editedJsonColumns(update), editedAt: Date.now() })
    .where(inboxRow(owner, dmId, messageId))
    .run();
  const row = getDmMessageRow(db, owner, dmId, messageId);
  if (!row) throw new Error(`updateDmMessageFields: no such message ${messageId}`);
  return toDmRecord(row);
}

/**
 * Soft-delete (tombstone) an inbox DM (§7.1): keep its `id`/`seq`, clear
 * `content`, stamp `deleted_at = now`. The caller is responsible for
 * authorization BEFORE calling. Returns the tombstoned record. Throws if absent.
 */
export function tombstoneDmMessage(
  db: Db,
  owner: string,
  dmId: string,
  messageId: string,
): DmMessageRecord {
  db.drizzle
    .update(dmMessages)
    .set({ content: JSON.stringify(TOMBSTONE_CONTENT), deletedAt: Date.now() })
    .where(inboxRow(owner, dmId, messageId))
    .run();
  const row = getDmMessageRow(db, owner, dmId, messageId);
  if (!row) throw new Error(`tombstoneDmMessage: no such message ${messageId}`);
  return toDmRecord(row);
}
