/**
 * ChatView (P8) — the real-time chat experience for one text channel.
 *
 * Renders the message timeline (history + live, de-duped, with tombstones +
 * in-place edits), a composer (optimistic local echo, attachments, typing,
 * message-kind selection), per-message reactions + edit/delete + reply
 * affordances. Wires the live {@link OfscpWsClient} into the chat store via
 * {@link openChannel} and the command helpers.
 *
 * Message-type rendering (§5.3 / §2.3 forward-compat):
 *  - `message` / `memo` → plain text, `article` → sanitized markdown,
 *  - unknown `type` → generic best-effort text fallback (never crashes).
 *
 * Replies (§7.2):
 *  - a reply carries `reference = { type: "reply", id }`;
 *  - replies to a **memo/article** are hidden from the channel stream; they live
 *    in that post's reading pane, opened by clicking the memo/article card;
 *  - replies to a **chat message** render inline with a quoted-parent snippet.
 */
import type { Channel } from "@forumall/shared";
import {
  type Accessor,
  type Component,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { listMembers } from "../../lib/groups-api.ts";
import { formatTime } from "../../lib/time.ts";
import { clearActiveThread, setActiveThread } from "../../stores/active-thread.ts";
import {
  type ChatMessage,
  type ReactionGroup,
  chat,
  messagesFor,
  olderCursorFor,
  reactionsFor,
  typingFor,
} from "../../stores/chat.ts";
import {
  displayNameForInGroup,
  initialsFor,
  setGroupDisplayName,
  warmProfiles,
} from "../../stores/profiles.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { FollowToggle } from "../feed/FollowToggle.tsx";
import { AttachmentList } from "../shared/AttachmentList.tsx";
import { EditMessageForm } from "../shared/EditMessageForm.tsx";
import { EmptyState } from "../shared/EmptyState.tsx";
import { MessageStatus } from "../shared/MessageStatus.tsx";
import { ReactionBar, ReactionPicker } from "../shared/Reactions.tsx";
import { ReplyQuote } from "../shared/ReplyQuote.tsx";
import { RichText } from "../shared/RichText.tsx";
import { createUnreadDivider, trackNewestRead } from "../shared/read-tracking.ts";
import { Avatar } from "../social/Avatar.tsx";
import { openUserProfile } from "../social/user-profile-store.ts";
import { ArticleReadingPane, splitArticle } from "./ArticleReadingPane.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { type ChannelSession, startChannelSession } from "./channel-session.ts";
import {
  type ChannelHandle,
  addReactionCmd,
  deleteMessage,
  editMessage,
  loadReplies,
  removeReactionCmd,
  retrySend,
} from "./chat-controller.ts";
import { PROMOTE_TAG_PREFIX } from "./promote.ts";

/** Message kinds whose replies live in a reading pane, not the channel stream. */
function isLongForm(type: string | undefined): boolean {
  return type === "memo" || type === "article";
}

/** The source channel an article was promoted from, if its tags carry the marker. */
function promotedFrom(message: ChatMessage): string | undefined {
  const tag = message.tags?.find((t) => t.startsWith(PROMOTE_TAG_PREFIX));
  return tag ? tag.slice(PROMOTE_TAG_PREFIX.length) : undefined;
}

/** A plaintext one-glance excerpt of an article body for the channel card.
 *  Strips markdown markers — leading block markers (heading/blockquote/list) and
 *  horizontal rules per line, then inline emphasis/code anywhere — but keeps
 *  in-word hyphens, then collapses whitespace. */
function articleExcerpt(body: string): string {
  return body
    .replace(/^\s*(?:#{1,6}|>|[-*+])\s+/gm, "")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Header content-type filter: [filter value, label, icon]. "message" reads as "Chat". */
const TYPE_FILTERS: ["all" | "message" | "memo" | "article", string, IconName][] = [
  ["all", "All", "more"],
  ["message", "Chat", "chat"],
  ["article", "Articles", "article"],
  ["memo", "Memos", "memo"],
];

export const ChatView: Component<{
  channel: Channel;
  canPost: boolean;
  canModerate: boolean;
  /** Whether the actor may post memos / articles (defaults to `canPost`). */
  canPostMemo?: boolean;
  canPostArticle?: boolean;
}> = (props) => {
  const channelId = () => props.channel.id;
  const groupId = () => props.channel.groupId;

  const [handle, setHandle] = createSignal<ChannelHandle | null>(null);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [replyTarget, setReplyTarget] = createSignal<ChatMessage | null>(null);
  const [typeFilter, setTypeFilter] = createSignal<"all" | "message" | "memo" | "article">("all");
  const [sortMode, setSortMode] = createSignal<"recent" | "oldest" | "top">("recent");
  const [promoteSource, setPromoteSource] = createSignal<ChatMessage | null>(null);
  const [openArticle, setOpenArticle] = createSignal<ChatMessage | null>(null);

  // Reset the open article when the channel changes.
  createEffect(on(channelId, () => setOpenArticle(null)));

  // The open channel's session (null with no session client/WS). Its signal ends
  // every load made for the channel, so a reply listing still in flight at a
  // channel switch writes nothing.
  let channelSession: ChannelSession | null = null;

  const loadArticleReplies = async (messageId: string): Promise<void> => {
    const client = sessionClient();
    const session = channelSession;
    if (!client || !session) return;
    await loadReplies({
      client,
      groupId: groupId(),
      channelId: channelId(),
      messageId,
      signal: session.signal,
    }).catch(() => {});
  };

  // (Re)open the channel whenever it changes. The effect's cleanup (which runs
  // before the next channel opens, and on unmount) disposes the session at once,
  // closing the old channel even while it is still loading.
  createEffect(
    on(channelId, (id) => {
      const client = sessionClient();
      const ws = sessionWs();
      setHistoryError(null);
      setReplyTarget(null);
      setHandle(null);
      if (!client || !ws) return;
      const session = startChannelSession(
        { client, ws, groupId: groupId(), channelId: id },
        { opened: setHandle, failed: setHistoryError },
      );
      channelSession = session;
      onCleanup(() => {
        session.dispose();
        if (channelSession === session) channelSession = null;
      });
    }),
  );

  // Track the open channel as the global "active thread" (drives notify-fx sound
  // suppression — a message in the channel you're watching while focused + pinned
  // doesn't chime). Cleared on unmount.
  createEffect(on(channelId, (id) => setActiveThread("channel", id)));
  onCleanup(() => clearActiveThread());

  const messages = createMemo(() => messagesFor(channelId()));
  const typingActors = createMemo(() => typingFor(channelId()).filter((u) => u !== session.actor));

  // Warm the display-name cache for everyone named in the channel: message
  // authors, reaction authors, and anyone currently typing. Reactive + deduped,
  // so it covers history backfill, live arrivals, and resume with no extra reqs.
  createEffect(() => {
    const actors = new Set<string>();
    for (const m of messages()) {
      actors.add(m.author);
      for (const g of reactionsFor(channelId(), m.id)) for (const a of g.authors) actors.add(a);
    }
    for (const a of typingActors()) actors.add(a);
    warmProfiles(actors);
  });

  // Per-group nicknames (Overboard "Per-group display name"): seed the cache from
  // the group's member list when the group changes, then keep it live via
  // `member.updated` events fanned to this channel's subscribers. Non-fatal.
  createEffect(
    on(groupId, (gid) => {
      const client = sessionClient();
      if (client && gid) {
        void listMembers(client, gid)
          .then((list) => {
            for (const m of list) setGroupDisplayName(gid, m.user, m.displayNameOverride);
          })
          .catch(() => {});
      }
      const ws = sessionWs();
      if (!ws) return;
      const off = ws.on("member.updated", (e) => {
        const data = (
          e as {
            data?: { groupId?: string; member?: { user: string; displayNameOverride?: string } };
          }
        ).data;
        if (!data?.member || data.groupId !== gid) return;
        setGroupDisplayName(gid, data.member.user, data.member.displayNameOverride);
      });
      onCleanup(off);
    }),
  );

  // Index loaded messages + group replies by parent so we can render threads.
  const byId = createMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of messages()) map.set(m.id, m);
    return map;
  });
  const repliesByParent = createMemo(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const m of messages()) {
      const pid = m.reference?.id;
      if (pid) {
        const list = map.get(pid) ?? [];
        list.push(m);
        map.set(pid, list);
      }
    }
    return map;
  });

  /** Is this message hidden from the channel's main flow?
   *  Replies to a memo/article live in that post's reading pane (opened from the
   *  card), never inline in the stream. Chat replies always render inline with a
   *  quoted-parent reference. */
  const isNested = (m: ChatMessage): boolean => {
    const pid = m.reference?.id;
    if (!pid) return false;
    const parent = byId().get(pid);
    if (!parent) return false; // orphan reply (parent out of window) → stays inline
    return isLongForm(parent.type);
  };

  const roots = createMemo(() => messages().filter((m) => !isNested(m)));

  // Header type-filter + sort, derived over the already-loaded roots (the store
  // is kept chronological — ts ascending — so "recent" is the identity order).
  const reactionTotal = (msg: ChatMessage): number =>
    reactionsFor(channelId(), msg.id).reduce((sum, g) => sum + g.authors.length, 0);

  const visibleRoots = createMemo(() => {
    const f = typeFilter();
    const filtered = f === "all" ? roots() : roots().filter((m) => (m.type ?? "message") === f);
    const s = sortMode();
    if (s === "recent") return filtered;
    const arr = [...filtered];
    if (s === "oldest") return arr.reverse();
    return arr.sort((a, b) => reactionTotal(b) - reactionTotal(a)); // "top"
  });

  // Scroll anchor captured for the duration of a "load older" so prepending a
  // page doesn't move the content the user is reading. Non-null ⇒ a load is in
  // flight, which also suppresses the pin/"new below" reactions to the growing
  // message list (older history is not "new").
  let olderAnchor: { height: number; top: number } | null = null;

  const loadOlder = async (): Promise<void> => {
    const h = handle();
    if (!h || loadingOlder()) return;
    // Capture the pre-load geometry; after the prepend the same content sits
    // `newHeight - oldHeight` lower, so restoring that delta keeps it still.
    olderAnchor = scrollEl ? { height: scrollEl.scrollHeight, top: scrollEl.scrollTop } : null;
    setLoadingOlder(true);
    try {
      await h.loadOlder();
    } finally {
      setLoadingOlder(false);
      // Solid applies the store update synchronously, but late layout (fonts,
      // avatars) settles a tick later — restore on the next microtask, after the
      // list effects have run.
      queueMicrotask(() => {
        const anchor = olderAnchor;
        olderAnchor = null;
        if (!scrollEl || !anchor) return;
        scrollEl.scrollTop = scrollEl.scrollHeight - anchor.height + anchor.top;
      });
    }
  };

  // ---- Scroll management (sort-aware pin-to-bottom + jump-to-latest) ----
  // Only "recent" mode (newest-at-bottom) auto-pins to the bottom. In
  // "oldest"/"top" the bottom is the oldest / least-reacted row, so forcing a
  // scroll there is wrong — we leave the view where the user put it.
  // "Near the bottom" tolerance (px). Within this band we keep auto-pinning;
  // beyond it we assume the user is reading history and don't yank them.
  const NEAR_BOTTOM_PX = 80;
  // "Near the top" trigger band (px) for auto-loading the next older page — wide
  // enough that the next page is fetched just before the user hits the edge.
  const NEAR_TOP_PX = 150;

  let scrollEl: HTMLDivElement | undefined;
  let contentEl: HTMLDivElement | undefined;
  // Treat the very first paint / a channel switch as "pinned" so the initial
  // load lands at the bottom (the pre-existing behaviour).
  let pinned = true;
  const [showJump, setShowJump] = createSignal(false);
  const [hasNewBelow, setHasNewBelow] = createSignal(false);

  const isRecent = () => sortMode() === "recent";

  const atBottom = (): boolean => {
    if (!scrollEl) return true;
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < NEAR_BOTTOM_PX;
  };

  const scrollToBottom = (smooth = false): void => {
    if (!scrollEl) return;
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  const jumpToLatest = (): void => {
    pinned = true;
    setHasNewBelow(false);
    setShowJump(false);
    scrollToBottom(true);
  };

  // User scroll → recompute the pin state (recent mode only). Scrolling back to
  // the bottom re-arms the pin and clears the jump affordance. Scrolling to the
  // TOP pages in the next older window (the "Load older" button is the manual
  // fallback for the same call).
  const onScroll = (): void => {
    if (scrollEl && scrollEl.scrollTop < NEAR_TOP_PX && olderCursorFor(channelId())) {
      void loadOlder();
    }
    if (!isRecent()) {
      pinned = false;
      setShowJump(false);
      return;
    }
    pinned = atBottom();
    if (pinned) {
      setShowJump(false);
      setHasNewBelow(false);
    } else if (!showJump()) {
      setShowJump(true);
    }
  };

  // New messages: in recent mode, follow the bottom only if the user is pinned;
  // otherwise surface the jump-to-latest pill (flagged as "new below"). In
  // oldest/top we never force-scroll.
  createEffect(
    on(
      () => messages().length,
      (len, prev) => {
        // A "load older" prepend also grows the list — it must neither yank the
        // view to the bottom nor claim there are new messages below.
        if (olderAnchor) return;
        if (!isRecent()) return;
        if (pinned) {
          queueMicrotask(() => scrollToBottom(false));
        } else if (prev !== undefined && len > prev) {
          setHasNewBelow(true);
          setShowJump(true);
        }
      },
    ),
  );

  // Switching sort modes: into "recent" → pin + scroll to bottom; into
  // oldest/top → drop the pin and hide the jump pill (don't yank the view).
  createEffect(
    on(
      sortMode,
      (mode) => {
        if (mode === "recent") {
          pinned = true;
          setHasNewBelow(false);
          setShowJump(false);
          queueMicrotask(() => scrollToBottom(false));
        } else {
          pinned = false;
          setShowJump(false);
          setHasNewBelow(false);
        }
      },
      { defer: true },
    ),
  );

  // Channel switch: re-arm the pin so the new channel's history lands at the
  // bottom (mirrors initial-load behaviour).
  createEffect(
    on(
      channelId,
      () => {
        pinned = true;
        setHasNewBelow(false);
        setShowJump(false);
      },
      { defer: true },
    ),
  );

  // Robust pin: late-loading content (avatars, image attachments) grows the
  // scroll height AFTER the message effect's microtask. A ResizeObserver on the
  // message content keeps us glued to the bottom while pinned in recent mode.
  onMount(() => {
    if (!contentEl) return;
    const ro = new ResizeObserver(() => {
      if (isRecent() && pinned) scrollToBottom(false);
    });
    ro.observe(contentEl);
    onCleanup(() => ro.disconnect());
  });

  // ---- Read state: "New messages" divider + auto-mark-read (§7.7) -------
  // The divider is placed once per opened channel from the marker as it stood
  // on open. Auto-mark-read advances the marker to the newest loaded message
  // while the view is pinned at the bottom (`pinned` starts true on open, so
  // opening marks read; reading history scrolled up leaves the marker put).
  const dividerBeforeId = createUnreadDivider({
    scopeId: channelId,
    messages,
    ready: () => handle() !== null,
    self: () => session.actor ?? undefined,
  });
  trackNewestRead({ scopeId: channelId, messages, enabled: () => pinned });

  // Jump to the original post when a reply reference is clicked: scroll its row
  // into view and flash a transient highlight. No-op if the parent is older than
  // the loaded history (its row isn't in the DOM).
  const [highlightId, setHighlightId] = createSignal<string | null>(null);
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  const scrollToMessage = (id: string): void => {
    const el = scrollEl?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(id);
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => setHighlightId(null), 1600);
  };
  onCleanup(() => clearTimeout(highlightTimer));

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="chat-view" data-channel-id={channelId()}>
      <Show
        when={openArticle()}
        fallback={
          <>
            <header class="flex flex-col gap-2.5 border-b border-border px-[18px] py-3">
              <div class="flex items-center gap-2">
                <span class="font-mono text-faint">#</span>
                <h2
                  class="font-display text-base font-bold tracking-tight"
                  data-testid="chat-channel-name"
                >
                  {props.channel.name ?? props.channel.id}
                </h2>
                <span class="fa-meta hidden sm:inline">a stream of messages</span>
                <Show when={props.channel.topic}>
                  <span class="truncate text-xs text-faint">— {props.channel.topic}</span>
                </Show>
                <div class="ml-auto flex items-center gap-2">
                  <FollowToggle channelId={props.channel.id} groupId={props.channel.groupId} />
                </div>
              </div>

              {/* Content-type filter + sort (client-side over the loaded stream). */}
              <div class="flex flex-wrap items-center gap-1.5" data-testid="type-filter">
                <For each={TYPE_FILTERS}>
                  {([id, label, icon]) => (
                    <button
                      type="button"
                      data-testid={`filter-${id}`}
                      aria-pressed={typeFilter() === id}
                      onClick={() => setTypeFilter(id)}
                      class="inline-flex items-center gap-1.5 rounded-[6px] border-[1.5px] border-border-strong px-[11px] py-[5px] font-mono text-[12.5px] transition-transform hover:-translate-y-px"
                      classList={{
                        "bg-accent text-accent-ink": typeFilter() === id,
                        "bg-surface text-ink": typeFilter() !== id,
                      }}
                    >
                      <Show when={id !== "all"}>
                        <Icon name={icon} size={13} />
                      </Show>
                      {label}
                    </button>
                  )}
                </For>
                <label
                  class="ml-auto inline-flex items-center gap-1.5 rounded-md border-[1.5px] border-border-strong bg-surface px-2.5 py-1 font-mono text-[12.5px] text-muted focus-within:(outline outline-2 outline-accent)"
                  title="Sort messages"
                >
                  <Icon name="sort" size={14} />
                  <select
                    class="cursor-pointer bg-transparent text-ink outline-none"
                    data-testid="sort-select"
                    aria-label="Sort messages"
                    value={sortMode()}
                    onChange={(e) =>
                      setSortMode(e.currentTarget.value as "recent" | "oldest" | "top")
                    }
                  >
                    <option value="recent">Recent</option>
                    <option value="oldest">Oldest</option>
                    <option value="top">Top</option>
                  </select>
                </label>
              </div>
            </header>

            <div class="relative flex min-h-0 flex-1 flex-col">
              <div
                ref={scrollEl}
                onScroll={onScroll}
                class="min-h-0 flex-1 overflow-auto px-[18px] pt-1.5 pb-3.5"
                data-testid="message-list"
              >
                <div ref={contentEl}>
                  <Show when={olderCursorFor(channelId())}>
                    <div class="mb-3 flex justify-center">
                      <button
                        type="button"
                        class="btn-ghost px-3 py-1 text-xs"
                        onClick={() => void loadOlder()}
                        disabled={loadingOlder()}
                        data-testid="load-older"
                      >
                        {loadingOlder() ? "Loading…" : "Load older messages"}
                      </button>
                    </div>
                  </Show>

                  <Show when={historyError()}>
                    <p class="text-sm text-danger" data-testid="chat-history-error">
                      Could not load messages: {historyError()}
                    </p>
                  </Show>

                  <Show
                    when={visibleRoots().length > 0}
                    fallback={
                      <EmptyState
                        testid="chat-empty"
                        message={
                          typeFilter() === "all"
                            ? "No messages yet. Say hello."
                            : "Nothing here for this filter yet."
                        }
                      />
                    }
                  >
                    <ul class="flex flex-col gap-3">
                      <For each={visibleRoots()}>
                        {(msg, index) => (
                          <>
                            {/* "New messages" divider: above the first unread
                            message (snapshotted at open). Recent mode only — the
                            chronological order is what makes "above" meaningful. */}
                            <Show when={isRecent() && msg.id === dividerBeforeId()}>
                              <li
                                aria-label="New messages"
                                class="fa-divider fa-divider--new flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-wide text-accent"
                                data-testid="new-messages-divider"
                              >
                                <span class="h-px flex-1 bg-accent/40" />
                                <span>New messages</span>
                                <span class="h-px flex-1 bg-accent/40" />
                              </li>
                            </Show>
                            {/* Dashed separator between message groups (mirrors the
                            prototype's per-message `fa-divider--dashed`). */}
                            <Show when={index() > 0 && msg.id !== dividerBeforeId()}>
                              <li aria-hidden="true" class="fa-divider fa-divider--dashed" />
                            </Show>
                            <MessageNode
                              message={msg}
                              channelId={channelId()}
                              groupId={groupId()}
                              canModerate={props.canModerate}
                              canPromote={(props.canPostArticle ?? props.canPost) === true}
                              byId={byId}
                              highlightId={highlightId}
                              onJumpTo={scrollToMessage}
                              onReply={setReplyTarget}
                              onPromote={setPromoteSource}
                              onOpenArticle={setOpenArticle}
                            />
                          </>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              </div>

              {/* Jump-to-latest pill — shown only in recent mode when the user has
                scrolled up. Indicates when new messages arrived while away. */}
              <Show when={isRecent() && showJump()}>
                <button
                  type="button"
                  class="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-border-strong bg-surface px-3 py-1.5 font-mono text-[12px] text-ink shadow-[3px_3px_0_var(--shadow-col)] transition-transform hover:-translate-y-px"
                  data-testid="jump-to-latest"
                  onClick={jumpToLatest}
                >
                  <span aria-hidden="true">↓</span>
                  {hasNewBelow() ? "New messages" : "Jump to latest"}
                </button>
              </Show>
            </div>

            <TypingLine actors={typingActors()} groupId={groupId()} />

            <Show
              when={props.canPost}
              fallback={
                <div
                  class="border-t border-border px-[18px] py-3 text-xs text-faint"
                  data-testid="chat-readonly"
                >
                  You don't have permission to post in this channel.
                </div>
              }
            >
              <ChatComposer
                channel={props.channel}
                canPostMemo={props.canPostMemo ?? props.canPost}
                canPostArticle={props.canPostArticle ?? props.canPost}
                replyTarget={replyTarget}
                onClearReply={() => setReplyTarget(null)}
                promoteSource={promoteSource}
                onClearPromote={() => setPromoteSource(null)}
              />
            </Show>
          </>
        }
      >
        {(art) => (
          <ArticleReadingPane
            article={art()}
            kind={art().type === "memo" ? "memo" : "article"}
            groupId={groupId()}
            channelId={channelId()}
            canPost={props.canPost}
            replies={() => repliesByParent().get(art().id) ?? []}
            onLoadReplies={() => void loadArticleReplies(art().id)}
            onBack={() => setOpenArticle(null)}
          />
        )}
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Message node (a channel message + an optional quoted-parent reference)
// ---------------------------------------------------------------------------

const MessageNode: Component<{
  message: ChatMessage;
  channelId: string;
  groupId: string;
  canModerate: boolean;
  canPromote: boolean;
  byId: Accessor<Map<string, ChatMessage>>;
  highlightId: Accessor<string | null>;
  onJumpTo: (id: string) => void;
  onReply: (m: ChatMessage) => void;
  onPromote: (m: ChatMessage) => void;
  onOpenArticle: (m: ChatMessage) => void;
}> = (props) => {
  const m = () => props.message;

  const replyParent = () => {
    const pid = m().reference?.id;
    return pid ? props.byId().get(pid) : undefined;
  };

  return (
    <li class="flex flex-col gap-1">
      <Show when={m().reference}>
        <ReplyQuote
          parent={
            replyParent()
              ? {
                  id: (replyParent() as ChatMessage).id,
                  authorName: displayNameForInGroup(
                    (replyParent() as ChatMessage).author,
                    props.groupId,
                  ),
                  text: (replyParent() as ChatMessage).content.text ?? "",
                  deleted: (replyParent() as ChatMessage).deletedAt !== undefined,
                }
              : undefined
          }
          onJump={props.onJumpTo}
        />
      </Show>

      <MessageRow
        message={m()}
        channelId={props.channelId}
        groupId={props.groupId}
        canModerate={props.canModerate}
        canPromote={props.canPromote}
        highlighted={() => props.highlightId() === m().id}
        reactions={() => reactionsFor(props.channelId, m().id)}
        onReply={() => props.onReply(m())}
        onPromote={() => props.onPromote(m())}
        onOpenArticle={() => props.onOpenArticle(m())}
      />
    </li>
  );
};

// ---------------------------------------------------------------------------
// Message row
// ---------------------------------------------------------------------------

const MessageRow: Component<{
  message: ChatMessage;
  channelId: string;
  groupId: string;
  canModerate: boolean;
  canPromote: boolean;
  highlighted: () => boolean;
  reactions: () => ReactionGroup[];
  onReply: () => void;
  onPromote: () => void;
  onOpenArticle: () => void;
}> = (props) => {
  const m = () => props.message;
  const isAuthor = () => m().author === session.actor;
  const isDeleted = () => m().deletedAt !== undefined;
  const [editing, setEditing] = createSignal(false);
  const [editText, setEditText] = createSignal("");
  const [editError, setEditError] = createSignal<string | null>(null);

  const ws = () => sessionWs();

  const startEdit = (): void => {
    setEditText(m().content.text ?? "");
    setEditError(null);
    setEditing(true);
  };
  const submitEdit = (): void => {
    const w = ws();
    if (!w) return;
    const text = editText().trim();
    if (text.length === 0) return;
    setEditError(null);
    const frameId = editMessage({
      ws: w,
      groupId: props.groupId,
      channelId: props.channelId,
      messageId: m().id,
      text,
      mime: m().content.mime,
    });
    const off = w.on("error", (e) => {
      const err = e.data as { message?: string; correlationId?: string } | undefined;
      if ((e as { correlationId?: string }).correlationId !== frameId) return;
      setEditError(err?.message ?? "Could not edit this message.");
      off();
      offUpdated();
    });
    const offUpdated = w.on("message.updated", (e) => {
      const data = (e as { data?: { message?: { id?: string } } }).data;
      if (data?.message?.id !== m().id) return;
      setEditing(false);
      off();
      offUpdated();
    });
  };
  const doDelete = (): void => {
    const w = ws();
    if (!w) return;
    if (!confirm("Delete this message?")) return;
    deleteMessage({ ws: w, groupId: props.groupId, channelId: props.channelId, messageId: m().id });
  };

  const myReactionKeys = createMemo(
    () =>
      new Set(
        props
          .reactions()
          .filter((g) => session.actor != null && g.authors.includes(session.actor))
          .map((g) => g.key),
      ),
  );

  const toggleReaction = (key: string, unicode: string): void => {
    const w = ws();
    if (!w) return;
    const common = {
      ws: w,
      groupId: props.groupId,
      channelId: props.channelId,
      messageId: m().id,
      key,
    };
    if (myReactionKeys().has(key)) removeReactionCmd(common);
    else addReactionCmd({ ...common, unicode });
  };

  return (
    <div
      class="group/msg -mx-1.5 flex gap-[11px] rounded-md px-1.5 py-0.5 transition-colors duration-500"
      classList={{ "bg-accent/10 ring-1 ring-accent/30 duration-150": props.highlighted() }}
      data-testid="message-row"
      data-message-id={m().id}
      data-message-type={m().type ?? "message"}
      data-message-highlighted={props.highlighted() ? "1" : undefined}
      data-pending={m().pending ? "1" : undefined}
    >
      <button
        type="button"
        class="fa-ava transition-colors hover:border-accent"
        aria-label={`${displayNameForInGroup(m().author, props.groupId)} profile`}
        onClick={() => openUserProfile(m().author)}
      >
        <Avatar
          actor={m().author}
          initials={initialsFor(displayNameForInGroup(m().author, props.groupId))}
        />
      </button>
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="fa-msg__name hover:underline"
            data-testid="message-author"
            onClick={() => openUserProfile(m().author)}
          >
            {displayNameForInGroup(m().author, props.groupId)}
          </button>
          <span class="fa-meta">{formatTime(m().createdAt)}</span>
          <Show when={m().editedAt && !isDeleted()}>
            <span class="fa-meta" data-testid="message-edited">
              (edited)
            </span>
          </Show>
          <MessageStatus
            pending={m().pending}
            failed={m().failed}
            onRetry={() => {
              const w = ws();
              const clientMessageId = m().clientMessageId;
              if (w && clientMessageId) {
                retrySend({
                  ws: w,
                  groupId: props.groupId,
                  channelId: props.channelId,
                  clientMessageId,
                });
              }
            }}
          />

          {/* Message actions — always visible on touch; hover-revealed on desktop. */}
          <Show when={!isDeleted()}>
            <span class="ml-auto flex items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover/msg:opacity-100">
              <button
                type="button"
                class="btn-action"
                data-testid="reply-button"
                onClick={() => props.onReply()}
              >
                Reply
              </button>
              <Show when={props.canPromote && (m().type ?? "message") === "message"}>
                <button
                  type="button"
                  class="btn-action-secondary"
                  data-testid="promote-button"
                  title="Promote this message to an article"
                  onClick={() => props.onPromote()}
                >
                  Promote
                </button>
              </Show>
              <ReactionPicker onPick={(key, unicode) => toggleReaction(key, unicode)} />
              <Show when={isAuthor()}>
                <button
                  type="button"
                  class="btn-action"
                  data-testid="edit-message"
                  onClick={startEdit}
                >
                  Edit
                </button>
              </Show>
              <Show when={isAuthor() || props.canModerate}>
                <button
                  type="button"
                  class="btn-action-danger"
                  data-testid="delete-message"
                  onClick={doDelete}
                >
                  Delete
                </button>
              </Show>
            </span>
          </Show>
        </div>

        <Switch>
          <Match when={isDeleted()}>
            <p class="text-sm italic text-faint" data-testid="message-tombstone">
              message deleted
            </p>
          </Match>
          <Match when={editing()}>
            <EditMessageForm
              value={editText()}
              onInput={setEditText}
              onSubmit={submitEdit}
              onCancel={() => setEditing(false)}
              error={editError()}
            />
          </Match>
          <Match when={true}>
            <MessageBody message={m()} onOpenArticle={props.onOpenArticle} />
          </Match>
        </Switch>

        {/* Attachments */}
        <Show when={!isDeleted() && (m().attachments?.length ?? 0) > 0}>
          <AttachmentList attachments={m().attachments ?? []} testid="attachments" />
        </Show>

        {/* Reactions */}
        <ReactionBar
          reactions={props.reactions}
          myKeys={myReactionKeys}
          onToggle={toggleReaction}
          resolveName={(a) => displayNameForInGroup(a, props.groupId)}
        />
      </div>
    </div>
  );
};

/** Render a message body by §5.3 type, with a safe fallback for unknown types. */
export const MessageBody: Component<{ message: ChatMessage; onOpenArticle?: () => void }> = (
  props,
) => {
  const text = () => props.message.content.text ?? "";
  const type = () => props.message.type ?? "message";
  return (
    <Switch
      fallback={
        // Unknown type (§2.3 forward-compat): best-effort plain text, never crash.
        <p class="text-sm text-ink whitespace-pre-wrap break-words" data-testid="message-text">
          <RichText text={text()} />
        </p>
      }
    >
      <Match when={type() === "article"}>
        {/* Article renders as a bordered card with a clickable title + excerpt +
            a tags/replies foot, mirroring the prototype's article message card. */}
        <div class="mt-0.5 rounded-md border-[1.5px] border-border-strong bg-surface px-3.5 py-3.5">
          <Show when={promotedFrom(props.message)}>
            {(from) => (
              <div
                class="mb-2 inline-flex items-center gap-1.5 rounded-sm border-[1.5px] border-dashed border-ember bg-ember-soft px-2 py-0.5 text-[11px] font-mono uppercase tracking-wide text-ember"
                data-testid="promote-lineage"
              >
                <span aria-hidden="true">↳</span>
                promoted from {from()}
              </div>
            )}
          </Show>
          <button
            type="button"
            class="block text-left font-display text-base font-semibold text-ink transition-colors hover:text-accent"
            data-testid="open-article"
            onClick={() => props.onOpenArticle?.()}
          >
            {splitArticle(text()).title}
          </button>
          <p
            class="my-[7px] mb-[11px] line-clamp-3 text-sm text-muted"
            data-testid="message-article"
          >
            {articleExcerpt(splitArticle(text()).body)}
          </p>
          <div class="flex flex-wrap items-center justify-between gap-2.5">
            <div class="flex flex-wrap items-center gap-[7px]">
              <For
                each={(props.message.tags ?? []).filter((t) => !t.startsWith(PROMOTE_TAG_PREFIX))}
              >
                {(t) => <span class="fa-tag">{t}</span>}
              </For>
            </div>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 font-mono text-[11px] text-accent hover:underline"
              data-testid="open-article-replies"
              onClick={() => props.onOpenArticle?.()}
            >
              <Icon name="reply" size={12} />
              {props.message.replyCount ? `${props.message.replyCount} replies` : "Open article"}
            </button>
          </div>
          <div class="fa-divider fa-divider--dashed my-[11px]" />
        </div>
      </Match>
      <Match when={type() === "memo"}>
        {/* Memo renders as a phosphor-bordered card (social-style post). Clicking
            it opens the reading pane, where its replies + reply composer live. */}
        <button
          type="button"
          class="mt-1 block w-full rounded-md border-[1.5px] border-accent bg-surface p-3.5 text-left transition-colors hover:bg-surface-2"
          data-testid="open-memo"
          onClick={() => props.onOpenArticle?.()}
        >
          <p class="text-sm text-ink whitespace-pre-wrap break-words" data-testid="message-text">
            <RichText text={text()} />
          </p>
        </button>
      </Match>
      <Match when={type() === "message"}>
        <p class="text-sm text-ink whitespace-pre-wrap break-words" data-testid="message-text">
          <RichText text={text()} />
        </p>
      </Match>
    </Switch>
  );
};

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

const TypingLine: Component<{ actors: string[]; groupId: string }> = (props) => (
  <Show when={props.actors.length > 0}>
    <div class="px-[18px] py-1 text-xs text-faint" data-testid="typing-indicator">
      {typingText(props.actors, props.groupId)}
    </div>
  </Show>
);

function typingText(actors: string[], groupId: string): string {
  const names = actors.map((a) => displayNameForInGroup(a, groupId));
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Short HH:MM time for a message timestamp; empty when absent/unparseable. */

// Re-export so a parent can read the store reactively if needed.
export { chat };
