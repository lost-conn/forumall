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
import type { Attachment, DmConversation, Message, Reaction } from "@forumall/shared";
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
  opts: { attachments?: Attachment[]; reference?: { type: string; id: string } } = {},
): Promise<SendDmResult> {
  const clientMessageId = newClientMessageId();
  const res = await client.post<Message>(`/api/federation/dms/${dmId}/messages`, {
    clientMessageId,
    content,
    ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
    ...(opts.reference ? { reference: opts.reference } : {}),
  });
  return { message: res.data, clientMessageId };
}

/**
 * Read one page of the replies to a DM message (§7.2), oldest-first. Same shape
 * as the channel replies endpoint; returns the reply messages + the next cursor.
 * The server embeds each reply's `reactions` aggregate onto the message.
 */
export async function fetchDmReplies(
  client: OfscpClient,
  dmId: string,
  messageId: string,
  opts: { cursor?: string; limit?: number; direction?: "backward" | "forward" } = {},
): Promise<DmMessagesPageResult> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  params.set("direction", opts.direction ?? "forward");
  const qs = params.toString();
  const res = await client.get<{ items: Message[]; page: { nextCursor?: string | null } }>(
    `/api/dms/${dmId}/messages/${messageId}/replies${qs ? `?${qs}` : ""}`,
  );
  return { messages: res.data.items ?? [], nextCursor: res.data.page?.nextCursor ?? null };
}

/**
 * Add the caller's reaction `key` to a DM message via the signed session client
 * (`PUT …/reactions/{key}`; 201 first add / 200 repeat). Always addressed to the
 * caller's HOME provider — the server forwards cross-provider per §8.3.
 */
export async function addDmReaction(
  client: OfscpClient,
  dmId: string,
  messageId: string,
  key: string,
): Promise<void> {
  await client.put<unknown>(
    `/api/dms/${dmId}/messages/${messageId}/reactions/${encodeURIComponent(key)}`,
    {},
  );
}

/** Remove the caller's reaction `key` from a DM message (`DELETE …`; 204). */
export async function removeDmReaction(
  client: OfscpClient,
  dmId: string,
  messageId: string,
  key: string,
): Promise<void> {
  await client.delete<unknown>(
    `/api/dms/${dmId}/messages/${messageId}/reactions/${encodeURIComponent(key)}`,
  );
}

/** Edit a DM message in place via `PATCH …` (author-only, edit window). */
export async function editDmMessage(
  client: OfscpClient,
  dmId: string,
  messageId: string,
  content: { mime: string; text: string },
): Promise<Message> {
  const res = await client.patch<Message>(`/api/dms/${dmId}/messages/${messageId}`, { content });
  return res.data;
}

/** Delete (tombstone) a DM message via `DELETE …` (204). */
export async function deleteDmMessage(
  client: OfscpClient,
  dmId: string,
  messageId: string,
): Promise<void> {
  await client.delete<unknown>(`/api/dms/${dmId}/messages/${messageId}`);
}

// Re-export the reaction type so callers can fold the embedded history aggregate.
export type { Reaction };
