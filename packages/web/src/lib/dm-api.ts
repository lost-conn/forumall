/**
 * Direct-message REST surface (spec §7.4).
 *
 * Three signed endpoints, all through the session's signing {@link OfscpClient}:
 *  - `POST /api/federation/dms/{dmId}/messages` — the single user-signed DM send
 *    path. The recipient's provider stores it in the recipient's inbox and emits
 *    `dm.message`; the response is the canonical sent {@link Message} the SENDER
 *    retains locally (the server keeps no sender copy, §8.3).
 *  - `GET /api/me/dms` — the caller's DM conversations (reconstructed from the
 *    caller's inbox), newest-first.
 *  - `GET /api/dms/{dmId}/messages` — the caller's OWN inbox for a conversation
 *    (RECEIVED messages only — no sender copy).
 *
 * Live `dm.message` events flow over the WS (`OfscpWsClient`), subscribed with
 * the `dm_` id as the channel; these REST calls list conversations + backfill
 * received history.
 */
import type { DmConversation, Message } from "@forumall/shared";
import { newClientMessageId } from "./chat-api.ts";
import type { OfscpClient } from "./ofscp-client.ts";

/** Result of reading one page of a DM inbox timeline. */
export interface DmMessagesPageResult {
  /** RECEIVED messages (the caller's inbox copies) for the conversation. */
  messages: Message[];
  nextCursor: string | null;
}

/**
 * Read one page of the caller's INBOX history for `dmId`, oldest-first
 * (forward), so the merged thread renders in chronological order. Returns the
 * caller's RECEIVED messages only — never their own sent copies (§8.3).
 */
export async function fetchDmMessages(
  client: OfscpClient,
  dmId: string,
  opts: { cursor?: string; limit?: number; direction?: "backward" | "forward" } = {},
): Promise<DmMessagesPageResult> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  params.set("direction", opts.direction ?? "forward");
  const qs = params.toString();
  const res = await client.get<{ items: Message[]; page: { nextCursor?: string | null } }>(
    `/api/dms/${dmId}/messages${qs ? `?${qs}` : ""}`,
  );
  return {
    messages: res.data.items ?? [],
    nextCursor: res.data.page?.nextCursor ?? null,
  };
}

/**
 * List the caller's DM conversations (§7.4), newest-first. The server
 * reconstructs these from the caller's inbox, so a conversation the caller has
 * only SENT to (no received messages yet) will NOT appear here — the UI merges
 * those in from the local sent-store.
 */
export async function fetchDmConversations(client: OfscpClient): Promise<DmConversation[]> {
  const res = await client.get<{ items: DmConversation[] }>("/api/me/dms");
  return res.data.items ?? [];
}

/** A successful DM send: the canonical sent message to retain locally. */
export interface SendDmResult {
  message: Message;
  clientMessageId: string;
}

/**
 * Send a DM via `POST /api/federation/dms/{dmId}/messages` (user-signed). Mints
 * a `clientMessageId` for idempotency + optimistic-echo correlation. On success
 * returns the canonical sent {@link Message} (the server's confirmation) which
 * the caller persists to the local sent-store — the recipient receives it via
 * their inbox + a `dm.message` WS event.
 */
export async function sendDmMessage(
  client: OfscpClient,
  dmId: string,
  content: { mime: string; text: string },
): Promise<SendDmResult> {
  const clientMessageId = newClientMessageId();
  const res = await client.post<Message>(`/api/federation/dms/${dmId}/messages`, {
    clientMessageId,
    content,
  });
  return { message: res.data, clientMessageId };
}
