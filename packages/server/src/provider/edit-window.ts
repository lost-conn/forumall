/**
 * Message edit windows (§5.3 `permissions.editUntil`, §7.1 *Editing*).
 *
 * The provider chooses the window per message. If a message has `editUntil`,
 * its author may edit it only while that instant is in the future; a message
 * without `editUntil` may be edited at any time. §7.1 says providers SHOULD
 * give `article` messages a longer window than chat, or none, so:
 *
 *  - chat types (`message`, `memo`) get `MESSAGE_EDIT_WINDOW_SECONDS`;
 *  - an `article` gets `ARTICLE_EDIT_WINDOW_SECONDS`, and no window at all
 *    (no `editUntil`) when that knob is unset, the default.
 *
 * A DM is always a `message` (§7.4), so it always has a window.
 */
import type { Message } from "@forumall/shared";

import type { Config } from "../config.ts";

/** The config knobs the window depends on. */
export type EditWindowConfig = Pick<
  Config,
  "messageEditWindowSeconds" | "articleEditWindowSeconds"
>;

/**
 * The end of the edit window (epoch millis) for a message of `type` created at
 * `createdAt`, or `null` when the message has no time limit.
 */
export function editWindowEnd(
  config: EditWindowConfig,
  type: Message["type"],
  createdAt: number,
): number | null {
  const seconds =
    type === "article" ? config.articleEditWindowSeconds : config.messageEditWindowSeconds;
  return seconds === null ? null : createdAt + seconds * 1000;
}

/**
 * Whether a message whose window ends at `editUntil` (epoch millis; `null` = no
 * limit) may still be edited at `now`: the end must be strictly in the future.
 */
export function isEditWindowOpen(editUntil: number | null, now: number = Date.now()): boolean {
  return editUntil === null || now < editUntil;
}
