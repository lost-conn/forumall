/**
 * The shared "a channel message was created → derive inbound notifications and
 * fan them to the live inbox" helper (§10.1). Both create paths — WS
 * `message.create` and REST `POST …/messages` — reach it through
 * `createChannelMessage` (`http/message-create.ts`); edits never call it, since
 * edits never create notification entries (§7.1, §10.1).
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
import { type PushPayload, previewText, sendPushToRecipient } from "./push-send.ts";

/**
 * The publish surface this helper needs from the hub: per-actor fan-out plus the
 * live-connection gate (push is only sent when the recipient is disconnected).
 */
export interface NotificationCreatedFanout {
  publishToActor(actor: string, event: { type: string; data: unknown }): void;
  liveConnectionCount(actor: string): number;
}

/** Inputs describing the channel message that was just created. */
export interface MessageNotificationInput {
  readonly text: string;
  /** The message's `mentions` (§5.3), or undefined to parse them from `text`. */
  readonly mentions?: readonly string[] | undefined;
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
      ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
      author: input.author,
      sourceMessageId: input.sourceMessageId,
      channelId: input.channelId,
      groupId: input.groupId,
      localDomain,
      ...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
    });
    const out: Notification[] = [];
    for (const { recipient, notification } of created) {
      const recipientActor = `${recipient}@${localDomain}`;
      hub.publishToActor(recipientActor, {
        type: "notification.created",
        data: { notification },
      });
      // Push: only when the recipient has NO live WS connection (a connected
      // recipient already got the in-app chime/badge). Fire-and-forget — never
      // block or fail message creation.
      if (hub.liveConnectionCount(recipientActor) === 0) {
        const payload = channelPushPayload(notification, input.text);
        void sendPushToRecipient(db, config, recipientActor, payload);
      }
      out.push(notification);
    }
    return out;
  } catch (err) {
    console.error("inbound notification creation failed:", err);
    return [];
  }
}

/** Build the Web Push payload for a channel mention/reply/message notification. */
function channelPushPayload(notification: Notification, text: string): PushPayload {
  const { type, author, groupId, channelId, sourceMessageId } = notification;
  const handle = author.includes("@") ? author.slice(0, author.lastIndexOf("@")) : author;
  const title =
    type === "reply"
      ? `New reply from ${handle}`
      : type === "message"
        ? `New message from ${handle}`
        : `New mention from ${handle}`;
  return {
    title,
    body: previewText(text),
    tag: `chan:${groupId}`,
    data: {
      type,
      groupId,
      channelId,
      messageId: sourceMessageId,
      targetUrl: `/groups/${groupId}`,
    },
  };
}
