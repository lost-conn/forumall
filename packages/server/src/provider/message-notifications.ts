/**
 * The shared "a channel message was created → derive inbound notifications and
 * fan them to the live inbox" helper (a provider-LOCAL extension). Factored out
 * of the WS create handler so any channel message-create path can call it (today
 * only the WS `message.create` handler creates channel messages; a future REST
 * create path would call the same helper).
 *
 * It runs detection ({@link notifyForChannelMessage}) and then fans a
 * `notification.created` WS event to each distinct local recipient via
 * `hub.publishToActor`, so a connected recipient sees the mention/reply live. It
 * is intentionally DEFENSIVE + NON-BLOCKING: a throw here must never break
 * message creation, so callers invoke it fire-and-forget and it swallows/logs its
 * own errors.
 *
 * Distinct from the §10 OUTBOUND notification webhooks (`provider/notifications.ts`).
 */
import { type Notification, canonicalAuthority } from "@forumall/shared";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { notifyForChannelMessage } from "./notifications-feed.ts";

/** The publish surface this helper needs from the hub (just actor fan-out). */
export interface NotificationCreatedFanout {
  publishToActor(actor: string, event: { type: string; data: unknown }): void;
}

/** Inputs describing the channel message that was just created. */
export interface MessageNotificationInput {
  readonly text: string;
  readonly author: string;
  readonly sourceMessageId: string;
  readonly channelId: string;
  readonly groupId: string;
  /** Parent message id when this message is a reply, else undefined. */
  readonly replyToId?: string | undefined;
}

/**
 * Detect + persist inbound notifications for a channel message and fan a
 * `notification.created` event to each recipient (the recipient is local, so the
 * fan-out target is `handle@<thisDomain>`). NEVER throws: any error is caught and
 * logged so message creation is unaffected. Returns the created notifications
 * (mostly for tests); on error returns an empty array.
 */
export function fireMessageNotifications(
  db: Db,
  config: Config,
  hub: NotificationCreatedFanout,
  input: MessageNotificationInput,
): Notification[] {
  try {
    const localDomain = canonicalAuthority(config.domain);
    const created = notifyForChannelMessage(db, {
      text: input.text,
      author: input.author,
      sourceMessageId: input.sourceMessageId,
      channelId: input.channelId,
      groupId: input.groupId,
      localDomain,
      ...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
    });
    const out: Notification[] = [];
    for (const { recipient, notification } of created) {
      hub.publishToActor(`${recipient}@${localDomain}`, {
        type: "notification.created",
        data: { notification },
      });
      out.push(notification);
    }
    return out;
  } catch (err) {
    console.error("inbound notification creation failed:", err);
    return [];
  }
}
