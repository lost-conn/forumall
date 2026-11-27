/**
 * Chat controller (P8): the bridge between the live {@link OfscpWsClient} and the
 * reactive chat store for one open channel.
 *
 * `openChannel(...)` (driven from {@link ChatView}'s `onMount`) does the §7.1/§7.2
 * dance:
 *   1. load the most-recent history page over REST (backward paging) and backfill
 *      the timeline, then each loaded message's reactions from its own
 *      `…/reactions` listing (see `reaction-backfill.ts`) — only ONE page, so a busy
 *      channel doesn't drag its whole history down; the page's `nextCursor` is
 *      published to the store (`setOlderCursor`) so the view can page back,
 *      either from the "Load older" button or on a scroll to the top,
 *   2. subscribe over WS with `since` = the newest loaded cursor so live events
 *      resume without a gap (the server replays post-cursor messages; the store
 *      de-dupes the overlap by message id),
 *   3. register per-type WS listeners that fold `message.*` / `reaction.*` /
 *      `channel.typing` events into the store,
 *   4. record the channel's timeline head (`stores/timeline-heads.ts`) — the
 *      newest message the timeline delivered, which auto-mark-read names (§7.7):
 *      every live or resumed create moves it, and the newest history page
 *      settles it; older pages and reply listings never touch it.
 *
 * The channel has one lifetime, ended by `close()` or by the caller's `signal`.
 * Every REST load made for it (the first page, older pages, the reaction
 * backfills) carries that lifetime's signal: once it ends, queued requests never
 * start, in-flight ones are aborted, and an answer that still arrives is dropped
 * rather than written to the store. Writing it would be wrong, not just wasted:
 * with the listeners gone, nothing reconciles a stale snapshot against the live
 * events it missed (see `reaction-backfill.ts`).
 *
 * The command helpers (`sendMessage`, `editMessage`, `deleteMessage`,
 * `addReactionCmd`, `removeReactionCmd`, typing) emit the matching WS commands
 * through {@link OfscpWsClient.send}, which holds them until the connection is
 * authenticated (§7.1), and, for sends, manage the optimistic local echo.
 *
 * Everything here is transport/store wiring — the UI calls these and renders the
 * store; it never touches the WS client directly.
 */
import type {
  Message,
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
  type MessagesPageResult,
  fetchHistory,
  fetchReplies,
  newClientMessageId,
} from "../../lib/chat-api.ts";
import { mentionedActors } from "../../lib/mentions.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import type { OfscpWsClient } from "../../lib/ofscp-ws.ts";
import type { ChatMessage } from "../../stores/chat.ts";
import {
  addOptimistic,
  addReactionAgg,
  applyEdit,
  cursorFor,
  dropOptimistic,
  markOptimisticFailed,
  messagesFor,
  prependHistory,
  reconcileOptimistic,
  removeReactionAgg,
  setOlderCursor,
  setTyping,
  tombstoneMessage,
  upsertMessage,
} from "../../stores/chat.ts";
import {
  advanceTimelineHead,
  resetTimelineHead,
  settleTimelineHead,
} from "../../stores/timeline-heads.ts";
import { closedError, closedReason } from "../shared/open-session.ts";
import { backfillReactions, noteLiveReaction } from "./reaction-backfill.ts";

/**
 * Pending `message.create` sends, keyed by the command frame id. The author's
 * own `message.created` carries `correlationId` = the request frame id (§7.1);
 * we map that back to the `clientMessageId` to reconcile the optimistic echo.
 * (The message itself also echoes `clientMessageId` since ofscp#23, but the
 * correlation is per command, so a retried send still resolves its own entry.)
 * (Module-level so a channel re-open's fresh listeners still resolve in-flight
 * sends; entries are short-lived and removed on first match.)
 */
const pendingSends = new Map<string, { channelId: string; clientMessageId: string }>();

/** History page size for the initial + "load older" loads. */
export const HISTORY_PAGE_SIZE = 50;

/**
 * Map a canonical `Message` (§5.3) — a REST history item, or the full message a
 * `message.created` / `message.updated` event carries (ofscp#23) — to the
 * store's shape. `cursor` is the event's timeline cursor; a history item carries
 * its own (passthrough) `cursor`.
 */
function toChatMessage(m: Message, cursor?: string): ChatMessage {
  return {
    id: m.id,
    author: m.author,
    type: m.type,
    content: m.content,
    attachments: m.attachments,
    reference: m.reference,
    replyCount: m.replyCount,
    tags: m.tags,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    cursor: cursor ?? (m as { cursor?: string }).cursor,
    ...(m.clientMessageId !== undefined ? { clientMessageId: m.clientMessageId } : {}),
  };
}

export interface OpenChannelDeps {
  client: OfscpClient;
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  /**
   * Ends the channel from outside, as `close()` does. A view passes it so a
   * channel switch can close the old channel while it is still opening (before
   * there is a handle to close); the pending `openChannel` then rejects with the
   * signal's reason.
   */
  signal?: AbortSignal;
}

export interface ChannelHandle {
  /**
   * Load the next OLDER page of history; returns whether more remain. After
   * `close()` it writes nothing and resolves `false`.
   */
  loadOlder(): Promise<boolean>;
  /**
   * End the channel (channel switch / unmount): tear down the WS listeners,
   * unsubscribe, and abort every REST load still running for it. Idempotent.
   */
  close(): void;
}

/**
 * Open a channel: backfill history, subscribe with a resume cursor, and wire WS
 * events into the store. Returns a handle for "load older" + teardown. Rejects
 * with the signal's reason if `deps.signal` aborts before it is open.
 */
export async function openChannel(deps: OpenChannelDeps): Promise<ChannelHandle> {
  const { client, ws, groupId, channelId } = deps;
  deps.signal?.throwIfAborted();
  let olderCursor: string | null = null;
  // The channel's lifetime: every REST load below carries `signal`, and
  // `close()` aborts it (see the module doc).
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const backfillDeps = { client, groupId, channelId, signal };

  // Order matters: register the listeners + SUBSCRIBE synchronously BEFORE the
  // async history backfill. The server only fans `message.created` (incl. the
  // author's own correlated copy) to CURRENT channel subscribers — if we sent a
  // message before the subscribe landed, our optimistic echo would never
  // reconcile. Subscribing first (no `since`) closes that race; the store
  // de-dupes the history/live overlap by message id. We then advance the resume
  // cursor implicitly as live events arrive.

  // The timeline head starts over with this open: what the last open saw says
  // nothing about what this one has delivered.
  resetTimelineHead(channelId);

  // 1) Wire WS events → store. Each listener filters to THIS channel.
  const offCreated = ws.on("message.created", (e: WsEnvelope) => {
    const data = (e as WsMessageCreated).data;
    if (data.channelId !== channelId) return;
    const canonical = toChatMessage(data.message, data.cursor);
    // Author's own copy: correlate back to the pending send to reconcile the
    // optimistic echo, matching on the request `correlationId` the provider
    // echoes per §7.1. (A duplicate-create answer has no `cursor`, so it never
    // advances the resume point.)
    const correlationId = (e as { correlationId?: string }).correlationId;
    // A duplicate-create answer (correlated, no `cursor`) is the message stored
    // earlier, wherever it sits in the timeline. Every other create arrives in
    // commit order (live, or a resume replay up to now), so it is the newest.
    const duplicateAnswer = correlationId !== undefined && data.cursor === undefined;
    const pending = correlationId ? pendingSends.get(correlationId) : undefined;
    if (pending && pending.channelId === channelId) {
      pendingSends.delete(correlationId as string);
      reconcileOptimistic(channelId, pending.clientMessageId, canonical);
    } else {
      upsertMessage(channelId, canonical);
    }
    if (!duplicateAnswer) advanceTimelineHead(channelId, canonical.id);
  });

  // A correlated `error` answering one of our `message.create`s (e.g. `403` no
  // `post:<type>`, `400` a bad body, §7.1) means the provider stored nothing:
  // settle the pending send and mark its echo failed (retry stays available).
  const offError = ws.on("error", (e: WsEnvelope) => {
    const correlationId = e.correlationId;
    const pending = correlationId ? pendingSends.get(correlationId) : undefined;
    if (!pending || pending.channelId !== channelId) return;
    pendingSends.delete(correlationId as string);
    markOptimisticFailed(channelId, pending.clientMessageId);
  });

  const offUpdated = ws.on("message.updated", (e: WsEnvelope) => {
    const data = (e as WsMessageUpdated).data;
    if (data.channelId !== channelId) return;
    applyEdit(channelId, toChatMessage(data.message, data.cursor));
  });

  const offDeleted = ws.on("message.deleted", (e: WsEnvelope) => {
    const data = (e as WsMessageDeleted).data;
    if (data.channelId !== channelId) return;
    tombstoneMessage(channelId, data.messageId, data.deletedAt ?? rfc3339Timestamp());
  });

  const offReactionAdded = ws.on("reaction.added", (e: WsEnvelope) => {
    const data = (e as WsReactionAdded).data;
    if (data.channelId !== channelId) return;
    const reaction = data.reaction as Reaction;
    noteLiveReaction(channelId, reaction.reference.id, reaction.key, reaction.author);
    addReactionAgg(channelId, reaction);
  });

  const offReactionRemoved = ws.on("reaction.removed", (e: WsEnvelope) => {
    const data = (e as WsReactionRemoved).data;
    if (data.channelId !== channelId) return;
    noteLiveReaction(channelId, data.messageId, data.key, data.author);
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

  const close = (): void => {
    if (signal.aborted) return;
    lifetime.abort();
    deps.signal?.removeEventListener("abort", close);
    resetTimelineHead(channelId);
    offCreated();
    offError();
    offUpdated();
    offDeleted();
    offReactionAdded();
    offReactionRemoved();
    offTyping();
    ws.unsubscribe([channelId]);
  };
  deps.signal?.addEventListener("abort", close, { once: true });

  // 3) Backfill the most-recent history page (§7.2 backward paging), oldest→newest
  // into the store. Runs after the subscribe so live events can't open a gap.
  let page: MessagesPageResult;
  try {
    page = await fetchHistory(client, groupId, channelId, {
      limit: HISTORY_PAGE_SIZE,
      direction: "backward",
      signal,
    });
  } catch (err) {
    // A failed open leaves nothing subscribed; a closed one reports the close.
    close();
    throw closedReason(deps.signal) ?? err;
  }
  // Closed while the page was in flight: write nothing.
  if (signal.aborted) throw closedReason(deps.signal) ?? closedError("channel");
  olderCursor = page.nextCursor;
  // Publish the older cursor so the UI can offer "load older" / auto-page on a
  // scroll to the top. The closure variable above stays the fetch's own source
  // of truth; the store copy is purely what the view renders off.
  setOlderCursor(channelId, olderCursor);
  for (const m of [...page.messages].reverse()) {
    upsertMessage(channelId, toChatMessage(m));
  }
  // The newest page (newest first) settles the head against any create that
  // arrived while it was in flight.
  settleTimelineHead(
    channelId,
    page.messages.map((m) => m.id),
  );

  // A history page holds messages only (§7.2), so each loaded message's
  // reactions come from its own `…/reactions` listing; older pages and reply
  // listings go through the same backfill.
  await backfillReactions(
    backfillDeps,
    page.messages.map((m) => m.id),
  );
  if (signal.aborted) throw closedReason(deps.signal) ?? closedError("channel");

  return {
    async loadOlder(): Promise<boolean> {
      if (!olderCursor || signal.aborted) return false;
      let older: MessagesPageResult;
      try {
        older = await fetchHistory(client, groupId, channelId, {
          cursor: olderCursor,
          limit: HISTORY_PAGE_SIZE,
          direction: "backward",
          signal,
        });
      } catch (err) {
        if (signal.aborted) return false;
        throw err;
      }
      // Closed while the page was in flight: the store belongs to whatever
      // opens this channel next, so neither the page nor its cursor lands.
      if (signal.aborted) return false;
      // A backward page arrives NEWEST-first; reverse it so the block lands at
      // the front of the timeline in chronological order.
      prependHistory(
        channelId,
        [...older.messages].reverse().map((m) => toChatMessage(m)),
      );
      olderCursor = older.nextCursor;
      setOlderCursor(channelId, olderCursor);
      await backfillReactions(
        backfillDeps,
        older.messages.map((m) => m.id),
      );
      return !signal.aborted && olderCursor !== null;
    },
    close,
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
  /**
   * Re-send under an EXISTING idempotency key instead of minting a fresh one —
   * how {@link retrySend} makes a retry safe: if the first attempt was stored,
   * the provider answers with that message (§7.1) instead of storing another.
   */
  clientMessageId?: string;
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
  const clientMessageId = args.clientMessageId ?? newClientMessageId();
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
  // §5.3: the users the text names, as canonical actors. A bare `@handle` names
  // a user of the provider hosting the channel: the one this socket is to.
  const mentions = mentionedActors(text, ws.host);
  // Idempotent (§7.1: `clientMessageId`), so a create the connection dropped
  // before answering is re-sent on the next one; the provider's duplicate
  // answer then resolves this pending send like a first one.
  const sentFrameId = ws.send(
    "message.create",
    {
      groupId,
      channelId,
      clientMessageId,
      type: kind,
      content: { mime: mime ?? "text/plain", text },
      ...(reference ? { reference } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    },
    {
      idempotent: true,
      // Runs only after `send` has returned (even on a closed client), so
      // `sentFrameId` is assigned and the entry set below is the one removed.
      onUndelivered: () => {
        pendingSends.delete(sentFrameId);
        markOptimisticFailed(channelId, clientMessageId);
      },
    },
  );
  pendingSends.set(sentFrameId, { channelId, clientMessageId });
  return clientMessageId;
}

/**
 * Load the replies to `messageId` over REST (§7.2) and fold them into the store
 * (so they de-dupe against any already in the timeline). Used to expand a thread
 * / nest replies under a memo or article whose replies may be outside the loaded
 * history window. A reply listing holds messages only (§7.2), so each reply's
 * reactions are then backfilled from its own `…/reactions` listing.
 *
 * `signal` is the open channel's lifetime (a view passes the one it opened the
 * channel with): once it aborts, the requests are aborted and nothing more is
 * written, and the returned promise resolves quietly.
 */
export async function loadReplies(deps: {
  client: OfscpClient;
  groupId: string;
  channelId: string;
  messageId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { client, groupId, channelId, messageId, signal } = deps;
  if (signal?.aborted) return;
  let page: MessagesPageResult;
  try {
    page = await fetchReplies(client, groupId, channelId, messageId, {
      limit: HISTORY_PAGE_SIZE,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  }
  if (signal?.aborted) return;
  for (const m of page.messages) upsertMessage(channelId, toChatMessage(m));
  await backfillReactions(
    { client, groupId, channelId, ...(signal ? { signal } : {}) },
    page.messages.map((m) => m.id),
  );
}

/**
 * Retry a failed optimistic send: resend the failed echo's whole message — kind,
 * body, reply pointer, attachments, tags — under its ORIGINAL `clientMessageId`,
 * so a send that did land is answered with the stored message (§7.1) rather
 * than duplicated. Does nothing if no failed echo with that id is in the store.
 */
export function retrySend(args: {
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  clientMessageId: string;
}): void {
  const { ws, groupId, channelId, clientMessageId } = args;
  const echo = messagesFor(channelId).find(
    (m) => m.failed && m.clientMessageId === clientMessageId,
  );
  if (!echo) return;
  dropOptimistic(channelId, clientMessageId);
  sendMessage({
    ws,
    groupId,
    channelId,
    author: echo.author,
    text: echo.content.text ?? "",
    mime: echo.content.mime,
    ...(isComposerKind(echo.type) ? { type: echo.type } : {}),
    ...(echo.reference ? { reference: echo.reference } : {}),
    ...(echo.attachments && echo.attachments.length > 0 ? { attachments: echo.attachments } : {}),
    ...(echo.tags && echo.tags.length > 0 ? { tags: echo.tags } : {}),
    clientMessageId,
  });
}

/** The kinds {@link sendMessage} creates. */
function isComposerKind(type: string | undefined): type is "message" | "memo" | "article" {
  return type === "message" || type === "memo" || type === "article";
}

/**
 * Edit a message; returns the command frame id (for `error` correlation).
 *
 * §5.3 `mentions` is the message's authoritative mention list, and §7.1 keeps
 * any field an update omits. So the edit always resends `mentions`, recomputed
 * from the new text — `[]` when it names nobody any more — or the old list
 * would outlive the text that named those users.
 */
export function editMessage(args: {
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  messageId: string;
  text: string;
  mime?: string;
}): string {
  return args.ws.send("message.update", {
    groupId: args.groupId,
    channelId: args.channelId,
    messageId: args.messageId,
    content: { mime: args.mime ?? "text/plain", text: args.text },
    mentions: mentionedActors(args.text, args.ws.host),
  });
}

/** Delete a message; returns the command frame id (for `error` correlation). */
export function deleteMessage(args: {
  ws: OfscpWsClient;
  groupId: string;
  channelId: string;
  messageId: string;
}): string {
  return args.ws.send("message.delete", {
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
  args.ws.send("reaction.add", {
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
  args.ws.send("reaction.remove", {
    groupId: args.groupId,
    channelId: args.channelId,
    messageId: args.messageId,
    key: args.key,
  });
}

/** Typing is a live signal: dropped, never queued, while disconnected. */
export function typingStart(ws: OfscpWsClient, channelId: string): void {
  ws.send("typing.start", { channelId }, { whenDisconnected: "drop" });
}

export function typingStop(ws: OfscpWsClient, channelId: string): void {
  ws.send("typing.stop", { channelId }, { whenDisconnected: "drop" });
}
