/**
 * Channels + messages store (P8). Holds the per-channel message timeline the
 * chat/feed cards render, keyed by channel id, plus a lightweight channel index.
 * The WS client feeds this via `on("message.created" | "message.updated" |
 * "message.deleted", …)`; REST history backfills it. Minimal but real.
 */
import { createStore, produce } from "solid-js/store";

/** A message as the client cares about it (superset of the WS payload). */
export interface ChatMessage {
  id: string;
  author: string;
  content: { mime?: string; text?: string };
  createdAt?: string;
  editedAt?: string;
  deletedAt?: string;
  /** Resume cursor delivered alongside the message (§7.1 / §7.2 shared space). */
  cursor?: string;
}

export interface ChannelSummary {
  id: string;
  groupId?: string;
  name?: string;
  type?: string;
  tier?: string;
}

interface ChatState {
  /** Known channels by id. */
  channels: Record<string, ChannelSummary>;
  /** Message timeline per channel id (ascending by arrival). */
  messages: Record<string, ChatMessage[]>;
  /** Latest resume cursor seen per channel id. */
  cursors: Record<string, string>;
}

const [chat, setChat] = createStore<ChatState>({
  channels: {},
  messages: {},
  cursors: {},
});

export { chat };

export function upsertChannel(channel: ChannelSummary): void {
  setChat("channels", channel.id, (prev) => ({ ...prev, ...channel }));
}

/** Append or replace a message in a channel timeline (de-dupe by id). */
export function upsertMessage(channelId: string, message: ChatMessage): void {
  setChat(
    produce((s) => {
      if (!s.messages[channelId]) s.messages[channelId] = [];
      const list = s.messages[channelId];
      const idx = list.findIndex((m) => m.id === message.id);
      if (idx === -1) list.push(message);
      else list[idx] = { ...list[idx], ...message };
      if (message.cursor) s.cursors[channelId] = message.cursor;
    }),
  );
}

/** Mark a message tombstoned (clear content, set deletedAt). */
export function tombstoneMessage(channelId: string, messageId: string, deletedAt: string): void {
  setChat(
    produce((s) => {
      const list = s.messages[channelId];
      const msg = list?.find((m) => m.id === messageId);
      if (msg) {
        msg.deletedAt = deletedAt;
        msg.content = { mime: "text/plain", text: "" };
      }
    }),
  );
}

export function messagesFor(channelId: string): ChatMessage[] {
  return chat.messages[channelId] ?? [];
}

export function cursorFor(channelId: string): string | undefined {
  return chat.cursors[channelId];
}

/** Reset all chat state (logout). */
export function clearChat(): void {
  setChat({ channels: {}, messages: {}, cursors: {} });
}
