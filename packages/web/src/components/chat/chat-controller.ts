/**
 * Chat controller (P8): the bridge between the live {@link OfscpWsClient} and the
 * reactive chat store for one open channel.
 *
 * `openChannel(...)` (driven from {@link ChatView}'s `onMount`) does the §7.1/§7.2
 * dance:
 *   1. load the most-recent history page over REST (backward paging) and backfill
 *      the timeline + per-message reaction history,
 *   2. subscribe over WS with `since` = the newest loaded cursor so live events
 *      resume without a gap (the server replays post-cursor messages; the store
 *      de-dupes the overlap by message id),
 *   3. register per-type WS listeners that fold `message.*` / `reaction.*` /
 *      `channel.typing` events into the store.
 *
 * The command helpers (`sendMessage`, `editMessage`, `deleteMessage`,
 * `addReaction`, `removeReaction`, typing) emit the matching WS commands and,
 * for sends, manage the optimistic local echo.
 *
 * Everything here is transport/store wiring — the UI calls these and renders the
 * store; it never touches the WS client directly.
 */
import type {
  Reaction,
  WsChannelTyping,
  WsEnvelope,
  WsMessageCreated,
  WsMessageDeleted,
  WsMessageUpdated,
  WsReactionAdded,
  WsReactionRemoved,
} from "@forumall/shared";
import { rfc3339Timestamp } from "@forumall/shared";
import {
  fetchHistory,
  fetchReactions,
  fetchReplies,
  newClientMessageId,
} from "../../lib/chat-api.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import type { OfscpWsClient } from "../../lib/ofscp-ws.ts";
import {
  addOptimistic,
  addReactionAgg,
  applyEdit,
  cursorFor,
  dropOptimistic,
  markOptimisticFailed,
  reconcileOptimistic,
  removeReactionAgg,
  setTyping,
  tombstoneMessage,
  upsertMessage,
} from "../../stores/chat.ts";

/** A single client message frame id counter (per session). */
let frameSeq = 0;
function frameId(prefix: string): string {
  frameSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${frameSeq.toString(36)}`;
}

/**
 * Pending `message.create` sends, keyed by the command frame id. The server's
 * canonical `message.created` payload does NOT echo our `clientMessageId`, but
 * the author's own copy carries `correlationId` = the request frame id (§7.1).
 * We map that back to the `clientMessageId` to reconcile the optimistic echo.
 * (Module-level so a channel re-open's fresh listeners still resolve in-flight
 * sends; entries are short-lived and removed on first match.)
 */
const pendingSends = new Map<string, { channelId: string; clientMessageId: string }>();

/**
 * Send a raw WS command frame through the client's underlying socket; returns the
 * frame `id` so a caller can correlate a later `error` event (echoed in the
 * error's `correlationId`) back to this command — used to surface an expired
 * edit-window 403, a delete-forbidden, etc.
 */
function sendCommand(ws: OfscpWsClient, type: string, data: Record<string, unknown>): string {
  // `OfscpWsClient` doesn't expose a generic command sender, so reach the socket
  // via a tiny structural cast. The client owns reconnect/auth; we only push
  // user commands once `connected`.
  const id = frameId(type.replace(/\W/g, ""));
  (ws as unknown as { sendRaw(frame: Record<string, unknown>): void }).sendRaw({
    id,
    type,
    ts: rfc3339Timestamp(),
    data,
  });
  return id;
}

/** History page size for the initial + "load older" loads. */
export const HISTORY_PAGE_SIZE = 50;

export interface OpenChannelDeps {
  client: OfscpClient;
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
}

export interface ChannelHandle {
  /** Load the next OLDER page of history; returns whether more remain. */
  loadOlder(): Promise<boolean>;
  /** Tear down the WS listeners + unsubscribe (channel switch / unmount). */
  close(): void;
}

/**
 * Open a channel: backfill history, subscribe with a resume cursor, and wire WS
 * events into the store. Returns a handle for "load older" + teardown.
 */
export async function openChannel(deps: OpenChannelDeps): Promise<ChannelHandle> {
  const { client, ws, groupId, channelId } = deps;
  let olderCursor: string | null = null;

  // Order matters: register the listeners + SUBSCRIBE synchronously BEFORE the
  // async history backfill. The server only fans `message.created` (incl. the
  // author's own correlated copy) to CURRENT channel subscribers — if we sent a
  // message before the subscribe landed, our optimistic echo would never
  // reconcile. Subscribing first (no `since`) closes that race; the store
  // de-dupes the history/live overlap by message id. We then advance the resume
  // cursor implicitly as live events arrive.

  // 1) Wire WS events → store. Each listener filters to THIS channel.
  const offCreated = ws.on("message.created", (e: WsEnvelope) => {
    const data = (e as WsMessageCreated).data;
    if (data.channelId !== channelId) return;
    const m = data.message;
    const canonical = {
      id: m.id,
      author: m.author,
      type: (m as { type?: string }).type,
      content: m.content,
      attachments: (m as { attachments?: never }).attachments,
      reference: (m as { reference?: { type: string; id: string } }).reference,
      replyCount: (m as { replyCount?: number }).replyCount,
      tags: (m as { tags?: string[] }).tags,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      cursor: data.cursor,
    };
    // Author's own copy: correlate back to the pending send to reconcile the
    // optimistic echo (the server doesn't echo `clientMessageId`, so we match on
    // the request `correlationId` it echoes per §7.1).
    const correlationId = (e as { correlationId?: string }).correlationId;
    const pending = correlationId ? pendingSends.get(correlationId) : undefined;
    if (pending && pending.channelId === channelId) {
      pendingSends.delete(correlationId as string);
      reconcileOptimistic(channelId, pending.clientMessageId, canonical);
      return;
    }
    upsertMessage(channelId, {
      ...canonical,
      ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
    });
  });

  const offUpdated = ws.on("message.updated", (e: WsEnvelope) => {
    const data = (e as WsMessageUpdated).data;
    if (data.channelId !== channelId) return;
    const m = data.message;
    applyEdit(channelId, {
      id: m.id,
      author: m.author,
      type: (m as { type?: string }).type,
      content: m.content,
      reference: (m as { reference?: { type: string; id: string } }).reference,
      tags: (m as { tags?: string[] }).tags,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      cursor: data.cursor,
    });
  });

  const offDeleted = ws.on("message.deleted", (e: WsEnvelope) => {
    const data = (e as WsMessageDeleted).data;
    if (data.channelId !== channelId) return;
    tombstoneMessage(channelId, data.messageId, data.deletedAt ?? rfc3339Timestamp());
  });

  const offReactionAdded = ws.on("reaction.added", (e: WsEnvelope) => {
    const data = (e as WsReactionAdded).data;
    if (data.channelId !== channelId) return;
    addReactionAgg(channelId, data.reaction as Reaction);
  });

  const offReactionRemoved = ws.on("reaction.removed", (e: WsEnvelope) => {
    const data = (e as WsReactionRemoved).data;
    if (data.channelId !== channelId) return;
    removeReactionAgg(channelId, data.messageId, data.key, data.author);
  });

  const offTyping = ws.on("channel.typing", (e: WsEnvelope) => {
    const data = (e as WsChannelTyping).data;
    if (data.channelId !== channelId) return;
    setTyping(channelId, data.user, data.state === "start");
  });

  // 2) Subscribe NOW (before history) with any resume cursor we already hold for
  // this channel (e.g. a prior open). The server replays post-cursor messages;
  // the store de-dupes the overlap with the history we load next, by message id.
  const since = cursorFor(channelId);
  ws.subscribe([channelId], since ? { since: { [channelId]: since } } : {});

  // 3) Backfill the most-recent history page (§7.2 backward paging), oldest→newest
  // into the store. Runs after the subscribe so live events can't open a gap.
  const page = await fetchHistory(client, groupId, channelId, {
    limit: HISTORY_PAGE_SIZE,
    direction: "backward",
  });
  olderCursor = page.nextCursor;
  for (const m of [...page.messages].reverse()) {
    upsertMessage(channelId, {
      id: m.id,
      author: m.author,
      type: m.type,
      content: m.content,
      attachments: m.attachments,
      reference: m.reference,
      replyCount: (m as { replyCount?: number }).replyCount,
      tags: m.tags,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      cursor: (m as { cursor?: string }).cursor,
    });
  }
  for (const r of page.reactions) addReactionAgg(channelId, r);

  // Backfill reaction history for each loaded message (the timeline page may not
  // include reactions for every message; this covers late-joiners reliably).
  await Promise.all(
    page.messages.map(async (m) => {
      try {
        const reactions = await fetchReactions(client, groupId, channelId, m.id);
        for (const r of reactions) addReactionAgg(channelId, r);
      } catch {
        /* a private/deleted message's reactions may 404 — ignore */
      }
    }),
  );

  return {
    async loadOlder(): Promise<boolean> {
      if (!olderCursor) return false;
      const older = await fetchHistory(client, groupId, channelId, {
        cursor: olderCursor,
        limit: HISTORY_PAGE_SIZE,
        direction: "backward",
      });
      for (const m of older.messages) {
        upsertMessage(channelId, {
          id: m.id,
          author: m.author,
          type: m.type,
          content: m.content,
          attachments: m.attachments,
          reference: m.reference,
          replyCount: (m as { replyCount?: number }).replyCount,
          tags: m.tags,
          createdAt: m.createdAt,
          editedAt: m.editedAt,
          deletedAt: m.deletedAt,
          cursor: (m as { cursor?: string }).cursor,
        });
      }
      for (const r of older.reactions) addReactionAgg(channelId, r);
      olderCursor = older.nextCursor;
      return olderCursor !== null;
    },
    close(): void {
      offCreated();
      offUpdated();
      offDeleted();
      offReactionAdded();
      offReactionRemoved();
      offTyping();
      ws.unsubscribe([channelId]);
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface SendArgs {
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  author: string;
  text: string;
  mime?: string;
  /** §5.3 kind: `message` (default) | `memo` | `article`. */
  type?: "message" | "memo" | "article";
  /** §5.3 reply pointer to a parent message id. */
  reference?: { type: string; id: string };
  attachments?: import("@forumall/shared").Attachment[];
  /** §5.3 tags (e.g. article topics / a `promoted-from:#channel` lineage marker). */
  tags?: string[];
}

/**
 * Send a `message.create` with a generated `clientMessageId` and immediately show
 * an optimistic local echo (id `optimistic:<cmid>`). The author's canonical
 * `message.created` (echoing the command's id in `correlationId`) reconciles the
 * echo in place — see the `pendingSends` correlation in {@link openChannel}.
 */
export function sendMessage(args: SendArgs): string {
  const { ws, groupId, channelId, author, text, mime, type, reference, attachments, tags } = args;
  const kind = type ?? "message";
  const clientMessageId = newClientMessageId();
  addOptimistic(channelId, {
    id: `optimistic:${clientMessageId}`,
    author,
    type: kind,
    content: { mime: mime ?? "text/plain", text },
    ...(reference ? { reference } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    createdAt: rfc3339Timestamp(),
    clientMessageId,
  });
  try {
    const sentFrameId = sendCommand(ws, "message.create", {
      groupId,
      channelId,
      clientMessageId,
      type: kind,
      content: { mime: mime ?? "text/plain", text },
      ...(reference ? { reference } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    });
    pendingSends.set(sentFrameId, { channelId, clientMessageId });
  } catch {
    markOptimisticFailed(channelId, clientMessageId);
  }
  return clientMessageId;
}

/**
 * Load the replies to `messageId` over REST (§7.2) and fold them into the store
 * (so they de-dupe against any already in the timeline). Used to expand a thread
 * / nest replies under a memo or article whose replies may be outside the loaded
 * history window. Returns the reply messages in thread order.
 */
export async function loadReplies(deps: {
  client: OfscpClient;
  groupId: string;
  channelId: string;
  messageId: string;
}): Promise<void> {
  const { client, groupId, channelId, messageId } = deps;
  const page = await fetchReplies(client, groupId, channelId, messageId, {
    limit: HISTORY_PAGE_SIZE,
  });
  for (const m of page.messages) {
    upsertMessage(channelId, {
      id: m.id,
      author: m.author,
      type: m.type,
      content: m.content,
      attachments: m.attachments,
      reference: m.reference,
      replyCount: (m as { replyCount?: number }).replyCount,
      tags: m.tags,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      cursor: (m as { cursor?: string }).cursor,
    });
  }
  for (const r of page.reactions) addReactionAgg(channelId, r);
}

/** Retry a failed optimistic send: drop the failed echo and resend its content. */
export function retrySend(args: SendArgs & { clientMessageId: string }): void {
  dropOptimistic(args.channelId, args.clientMessageId);
  sendMessage(args);
}

/** Edit a message; returns the command frame id (for `error` correlation). */
export function editMessage(args: {
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  messageId: string;
  text: string;
  mime?: string;
}): string {
  return sendCommand(args.ws, "message.update", {
    groupId: args.groupId,
    channelId: args.channelId,
    messageId: args.messageId,
    content: { mime: args.mime ?? "text/plain", text: args.text },
  });
}

/** Delete a message; returns the command frame id (for `error` correlation). */
export function deleteMessage(args: {
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  messageId: string;
}): string {
  return sendCommand(args.ws, "message.delete", {
    groupId: args.groupId,
    channelId: args.channelId,
    messageId: args.messageId,
  });
}

export function addReactionCmd(args: {
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  messageId: string;
  key: string;
  unicode?: string;
}): void {
  sendCommand(args.ws, "reaction.add", {
    groupId: args.groupId,
    channelId: args.channelId,
    messageId: args.messageId,
    key: args.key,
    ...(args.unicode !== undefined ? { unicode: args.unicode } : {}),
  });
}

export function removeReactionCmd(args: {
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  messageId: string;
  key: string;
}): void {
  sendCommand(args.ws, "reaction.remove", {
    groupId: args.groupId,
    channelId: args.channelId,
    messageId: args.messageId,
    key: args.key,
  });
}

export function typingStart(ws: OfscpWsClient, channelId: string): void {
  sendCommand(ws, "typing.start", { channelId });
}

export function typingStop(ws: OfscpWsClient, channelId: string): void {
  sendCommand(ws, "typing.stop", { channelId });
}
