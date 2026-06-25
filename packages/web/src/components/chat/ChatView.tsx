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
import type { Attachment, Channel, Member } from "@forumall/shared";
import {
  type Accessor,
  type Component,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { uploadMedia } from "../../lib/chat-api.ts";
import { listMembers } from "../../lib/groups-api.ts";
import { renderMarkdown } from "../../lib/markdown.ts";
import {
  detectActiveMentionQuery,
  mentionRefFor,
  parseMentionSegments,
} from "../../lib/mentions.ts";
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
import { displayNameForInGroup, setGroupDisplayName, warmProfiles } from "../../stores/profiles.ts";
import { lastReadSeqFor, markRead, seqFromCursor } from "../../stores/read-markers.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { FollowToggle } from "../feed/FollowToggle.tsx";
import { AttachmentChips } from "../shared/AttachmentChips.tsx";
// `AttachmentView` is re-exported below so existing importers (the home feed)
// keep importing it from here unchanged after the extraction to `../shared`.
import { AttachmentView } from "../shared/AttachmentView.tsx";
import { EditMessageForm } from "../shared/EditMessageForm.tsx";
import { ReactionBar, ReactionPicker } from "../shared/Reactions.tsx";
import { ReplyContextPill } from "../shared/ReplyContextPill.tsx";
import { ReplyQuote } from "../shared/ReplyQuote.tsx";
import { Avatar } from "../social/Avatar.tsx";
import { openUserProfile } from "../social/user-profile-store.ts";
import { ArticleEditorOverlay } from "./ArticleEditorOverlay.tsx";
import { ArticleReadingPane, splitArticle } from "./ArticleReadingPane.tsx";
import {
  type ChannelHandle,
  addReactionCmd,
  deleteMessage,
  editMessage,
  loadReplies,
  openChannel,
  removeReactionCmd,
  retrySend,
  sendMessage,
  typingStart,
  typingStop,
} from "./chat-controller.ts";

/** Throttle window for `typing.start` re-emits while composing (ms). */
const TYPING_THROTTLE_MS = 2500;
/** Idle window after the last keystroke before emitting `typing.stop` (ms). */
const TYPING_IDLE_MS = 3000;

/** Message kinds whose replies live in a reading pane, not the channel stream. */
function isLongForm(type: string | undefined): boolean {
  return type === "memo" || type === "article";
}

/** Tag marker carrying an article's promote lineage: `promoted-from:#channel`. */
const PROMOTE_TAG_PREFIX = "promoted-from:";

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

  const loadArticleReplies = async (messageId: string): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    await loadReplies({ client, groupId: groupId(), channelId: channelId(), messageId }).catch(
      () => {},
    );
  };

  // (Re)open the channel whenever it changes. Tear down the previous wiring.
  createEffect(
    on(channelId, (id) => {
      const client = sessionClient();
      const ws = sessionWs();
      setHistoryError(null);
      setReplyTarget(null);
      handle()?.close();
      setHandle(null);
      if (!client || !ws) return;
      let cancelled = false;
      void openChannel({ client, ws, groupId: groupId(), channelId: id })
        .then((h) => {
          if (cancelled) h.close();
          else setHandle(h);
        })
        .catch((err) => setHistoryError(err instanceof Error ? err.message : String(err)));
      onCleanup(() => {
        cancelled = true;
      });
    }),
  );

  onCleanup(() => handle()?.close());

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

  const loadOlder = async (): Promise<void> => {
    const h = handle();
    if (!h || loadingOlder()) return;
    setLoadingOlder(true);
    try {
      await h.loadOlder();
    } finally {
      setLoadingOlder(false);
    }
  };

  // ---- Scroll management (sort-aware pin-to-bottom + jump-to-latest) ----
  // Only "recent" mode (newest-at-bottom) auto-pins to the bottom. In
  // "oldest"/"top" the bottom is the oldest / least-reacted row, so forcing a
  // scroll there is wrong — we leave the view where the user put it.
  // "Near the bottom" tolerance (px). Within this band we keep auto-pinning;
  // beyond it we assume the user is reading history and don't yank them.
  const NEAR_BOTTOM_PX = 80;

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
  // the bottom re-arms the pin and clears the jump affordance.
  const onScroll = (): void => {
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

  // ---- Read state: auto-mark-read + "New messages" divider --------------
  // The newest decodable `seq` among loaded messages (optimistic echoes carry no
  // cursor; tombstones/edits keep theirs). This is the high-water mark we advance
  // the read marker to.
  const newestSeq = createMemo(() => {
    let max = 0;
    for (const m of messages()) {
      const s = seqFromCursor(m.cursor);
      if (s != null && s > max) max = s;
    }
    return max;
  });

  // Divider anchor: snapshot the stored `lastReadSeq` when the channel opens, so
  // the "New messages" line stays put for this viewing session even as
  // auto-read advances the live marker (like real chat apps). The first message
  // with `seq > dividerSeq` (not authored by self) gets the divider above it.
  const [dividerSeq, setDividerSeq] = createSignal(0);
  createEffect(
    on(channelId, () => {
      // Snapshot on open. The hydrate/summary may land slightly after; the
      // memo below tolerates a 0 snapshot (no divider until there's a marker).
      setDividerSeq(lastReadSeqFor(channelId()));
    }),
  );

  // The id of the message the divider sits ABOVE: the oldest loaded message with
  // `seq > dividerSeq` that the viewer did not author. `null` → no divider.
  const dividerBeforeId = createMemo<string | null>(() => {
    const anchor = dividerSeq();
    if (anchor <= 0) return null;
    let best: { seq: number; id: string } | null = null;
    for (const m of messages()) {
      if (m.author === session.actor) continue;
      const s = seqFromCursor(m.cursor);
      if (s == null || s <= anchor) continue;
      if (!best || s < best.seq) best = { seq: s, id: m.id };
    }
    return best?.id ?? null;
  });

  // Auto-mark-read: while this channel is active AND pinned at the bottom (or on
  // initial open), advance the read marker to the newest loaded seq. As new
  // messages arrive while pinned, this re-fires and keeps the marker current.
  // Scrolled-up reading history → not pinned → we leave the marker put.
  createEffect(
    on(
      () => [channelId(), newestSeq()] as const,
      () => {
        const seq = newestSeq();
        if (seq <= 0) return;
        // `pinned` starts true on open/switch, so initial-open marks read; once
        // the user scrolls up it goes false and we stop advancing.
        if (pinned) markRead(channelId(), seq);
      },
    ),
  );

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
                      <p class="text-sm text-muted" data-testid="chat-empty">
                        {typeFilter() === "all"
                          ? "No messages yet. Say hello."
                          : "Nothing here for this filter yet."}
                      </p>
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
              <Composer
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
          initials={displayNameForInGroup(m().author, props.groupId).slice(0, 1).toUpperCase()}
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
          <Show when={m().pending}>
            <span class="text-[10px] text-cyan" data-testid="message-pending">
              sending…
            </span>
          </Show>
          <Show when={m().failed}>
            <button
              type="button"
              class="text-[10px] text-danger underline"
              data-testid="message-retry"
              onClick={() => {
                const w = ws();
                if (w && m().clientMessageId) {
                  retrySend({
                    ws: w,
                    groupId: props.groupId,
                    channelId: props.channelId,
                    author: m().author,
                    text: m().content.text ?? "",
                    clientMessageId: m().clientMessageId as string,
                  });
                }
              }}
            >
              failed — retry
            </button>
          </Show>

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
          <div class="flex flex-wrap gap-2" data-testid="attachments">
            <For each={m().attachments ?? []}>{(att) => <AttachmentView attachment={att} />}</For>
          </div>
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

/**
 * Render freeform body text with `@mention` tokens styled + clickable. Mirrors
 * the server's mention parse (`parseMentionSegments`) so a highlighted token is
 * exactly one the provider turned into a notification. Mentioning yourself stands
 * out (`bg-accent-soft`); clicking any token opens that user's profile.
 */
const MentionText: Component<{ text: string }> = (props) => {
  const localDomain = () => session.actor?.split("@")[1] ?? "";
  const segments = createMemo(() => parseMentionSegments(props.text, localDomain()));
  return (
    <For each={segments()}>
      {(seg) =>
        seg.type === "text" ? (
          <>{seg.value}</>
        ) : (
          <button
            type="button"
            class="rounded px-0.5 font-medium text-accent hover:underline"
            classList={{ "bg-accent-soft": seg.actor === session.actor }}
            data-testid="message-mention"
            data-actor={seg.actor}
            onClick={() => openUserProfile(seg.actor)}
          >
            {seg.raw}
          </button>
        )
      }
    </For>
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
          <MentionText text={text()} />
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
            <MentionText text={text()} />
          </p>
        </button>
      </Match>
      <Match when={type() === "message"}>
        <p class="text-sm text-ink whitespace-pre-wrap break-words" data-testid="message-text">
          <MentionText text={text()} />
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
// Composer
// ---------------------------------------------------------------------------

type ComposeKind = "message" | "memo" | "article";

const Composer: Component<{
  channel: Channel;
  canPostMemo: boolean;
  canPostArticle: boolean;
  replyTarget: Accessor<ChatMessage | null>;
  onClearReply: () => void;
  promoteSource: Accessor<ChatMessage | null>;
  onClearPromote: () => void;
}> = (props) => {
  const channelId = () => props.channel.id;
  const groupId = () => props.channel.groupId;
  const localDomain = () => session.actor?.split("@")[1] ?? "";
  const [text, setText] = createSignal("");
  const [kind, setKind] = createSignal<ComposeKind>("message");
  // @mention autocomplete: the group's members (for candidate matching), the
  // active query being typed (caret-relative), and the highlighted candidate.
  let inputRef: HTMLTextAreaElement | undefined;
  const [members] = createResource(groupId, (gid) => {
    const c = sessionClient();
    return c ? listMembers(c, gid) : Promise.resolve([]);
  });
  const [mentionQ, setMentionQ] = createSignal<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = createSignal(0);

  // Candidates: members whose handle OR per-group display name contains the
  // query (case-insensitive), excluding the current user, capped at 8. Resetting
  // the highlight to 0 when the query changes is handled where the query is set.
  const candidates = createMemo<Member[]>(() => {
    const q = mentionQ();
    if (!q) return [];
    const needle = q.query.toLowerCase();
    const out: Member[] = [];
    for (const m of members() ?? []) {
      if (m.user === session.actor) continue;
      const handle = m.user.split("@")[0]?.toLowerCase() ?? "";
      const name = displayNameForInGroup(m.user, groupId()).toLowerCase();
      if (needle === "" || handle.includes(needle) || name.includes(needle)) {
        out.push(m);
        if (out.length >= 8) break;
      }
    }
    return out;
  });

  /** Recompute the active mention query from the textarea's value + caret. */
  const refreshMentionQuery = (value: string): void => {
    const caret = inputRef?.selectionStart ?? value.length;
    const next = detectActiveMentionQuery(value, caret);
    setMentionQ(next);
    setMentionIdx(0);
  };

  /** Insert the chosen member's ref over the active query, then re-focus. */
  const acceptMention = (member: Member): void => {
    const q = mentionQ();
    if (!q) return;
    const ref = mentionRefFor(member.user, localDomain());
    const insert = `@${ref} `;
    const value = text();
    const from = q.start;
    const to = q.start + 1 + q.query.length;
    const next = value.slice(0, from) + insert + value.slice(to);
    setText(next);
    setMentionQ(null);
    const caret = from + insert.length;
    // Restore focus + caret after the value commits to the DOM.
    requestAnimationFrame(() => {
      if (!inputRef) return;
      inputRef.focus();
      inputRef.selectionStart = inputRef.selectionEnd = caret;
    });
  };
  const [pendingAttachments, setPendingAttachments] = createSignal<Attachment[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  // Article composer → a full-screen editor overlay. Promote chat→article opens
  // it prefilled with the source text + a lineage source channel (published as a
  // `promoted-from:` tag → rendered as a badge on the article).
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [editorPrefill, setEditorPrefill] = createSignal<string>("");
  const [promotedFromChannel, setPromotedFromChannel] = createSignal<string | null>(null);
  const channelName = (): string => props.channel.name ?? props.channel.id;
  const channelLabel = (): string => `#${channelName()}`;

  // When a promote is requested, open the article editor seeded with the source.
  createEffect(
    on(props.promoteSource, (src) => {
      if (!src) return;
      setKind("article");
      setEditorPrefill(src.content.text ?? "");
      setPromotedFromChannel(channelLabel());
      setEditorOpen(true);
    }),
  );

  const clearPromote = (): void => {
    setPromotedFromChannel(null);
    props.onClearPromote();
  };

  const openEditor = (): void => {
    setEditorPrefill("");
    setEditorOpen(true);
  };

  /** Publish an article from the overlay: assemble markdown + tags, then send. */
  const publishArticle = (args: { title: string; body: string; tags: string[] }): void => {
    const ws = sessionWs();
    if (!ws) return;
    const md = `${args.title ? `# ${args.title}\n\n` : ""}${args.body}`.trim();
    if (!md) return;
    const lineage = promotedFromChannel();
    const tags = [...args.tags, ...(lineage ? [`${PROMOTE_TAG_PREFIX}${lineage}`] : [])];
    sendMessage({
      ws,
      groupId: groupId(),
      channelId: channelId(),
      author: session.actor ?? "",
      text: md,
      type: "article",
      mime: "text/markdown",
      ...(tags.length > 0 ? { tags } : {}),
    });
    setEditorOpen(false);
    setKind("message");
    clearPromote();
  };

  let lastTypingStart = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let fileInput: HTMLInputElement | undefined;

  const stopTyping = (): void => {
    const ws = sessionWs();
    if (ws) typingStop(ws, channelId());
    lastTypingStart = 0;
    if (idleTimer) clearTimeout(idleTimer);
  };

  const onType = (value: string): void => {
    setText(value);
    refreshMentionQuery(value);
    const ws = sessionWs();
    if (!ws) return;
    const now = Date.now();
    if (now - lastTypingStart > TYPING_THROTTLE_MS) {
      typingStart(ws, channelId());
      lastTypingStart = now;
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  };

  const doSend = (): void => {
    const ws = sessionWs();
    if (!ws) return;
    const k = kind();
    const body = text().trim();
    const atts = pendingAttachments();
    if (body.length === 0 && atts.length === 0) return;
    setSendError(null);
    const target = props.replyTarget();
    try {
      sendMessage({
        ws,
        groupId: groupId(),
        channelId: channelId(),
        author: session.actor ?? "",
        text: body,
        type: k,
        mime: "text/plain",
        ...(target ? { reference: { type: "reply", id: target.id } } : {}),
        attachments: atts,
      });
      setText("");
      setKind("message");
      setPendingAttachments([]);
      props.onClearReply();
      clearPromote();
      stopTyping();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Could not send the message.");
    }
  };

  const onPickFile = async (file: File): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setUploading(true);
    setSendError(null);
    try {
      const att = await uploadMedia(client, file);
      setPendingAttachments((prev) => [...prev, att]);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInput) fileInput.value = "";
    }
  };

  onCleanup(() => {
    if (idleTimer) clearTimeout(idleTimer);
  });

  const kindButton = (k: ComposeKind, label: string, icon: IconName, show = true) => (
    <Show when={show}>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-sm border-[1.5px] border-border-strong px-3 py-[5px] font-mono text-[12.5px] transition-colors"
        classList={{
          "bg-accent text-accent-ink": kind() === k,
          "bg-surface text-muted hover:text-ink": kind() !== k,
        }}
        data-testid={`compose-kind-${k}`}
        aria-pressed={kind() === k}
        onClick={() => {
          setKind(k);
          if (k !== "article") clearPromote();
        }}
      >
        <Icon name={icon} size={13} />
        {label}
      </button>
    </Show>
  );

  return (
    <div class="border-t border-border px-[18px] pt-2.5 pb-3.5" data-testid="composer">
      {/* Reply context pill */}
      <Show when={props.replyTarget()}>
        {(t) => (
          <ReplyContextPill
            name={displayNameForInGroup(t().author, groupId())}
            onCancel={() => props.onClearReply()}
          />
        )}
      </Show>

      {/* Message-kind selector */}
      <div class="mb-[9px] flex items-center gap-[5px]" data-testid="compose-kind">
        {kindButton("message", "Message", "chat")}
        {kindButton("memo", "Memo", "memo", props.canPostMemo)}
        {kindButton("article", "Article", "article", props.canPostArticle)}
      </div>

      <AttachmentChips
        attachments={pendingAttachments()}
        onRemove={(i) => setPendingAttachments((prev) => prev.filter((_, j) => j !== i))}
        testid="composer-attachments"
      />

      <Switch>
        <Match when={kind() === "article"}>
          {/* Articles are written in the full editor (opens an overlay). */}
          <div class="flex items-center gap-[9px] rounded-md border-[1.5px] border-border-strong bg-surface px-3 py-2">
            <span class="text-faint">
              <Icon name="article" size={17} />
            </span>
            <span class="flex-1 text-sm text-faint">Articles are written in the full editor…</span>
            <button
              type="button"
              class="btn-accent shrink-0 px-2.5 py-[5px] text-[11px]"
              data-testid="open-article-editor"
              onClick={openEditor}
            >
              <Icon name="article" size={14} />
              Open editor
            </button>
          </div>
        </Match>
        <Match when={true}>
          <div class="relative">
            {/* @mention autocomplete dropdown, anchored above the input row. */}
            <Show when={mentionQ() && candidates().length > 0}>
              <div
                class="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-72 overflow-y-auto rounded-md border-[1.5px] border-border-strong bg-surface py-1 shadow-lg"
                data-testid="mention-autocomplete"
              >
                <For each={candidates()}>
                  {(m, i) => (
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
                      classList={{
                        "bg-surface-2": i() === mentionIdx(),
                        "hover:bg-surface-2": i() !== mentionIdx(),
                      }}
                      data-testid="mention-option"
                      data-actor={m.user}
                      // Prevent the textarea blur so the click still inserts.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => acceptMention(m)}
                    >
                      <span class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 text-[11px] font-mono uppercase text-muted">
                        <Avatar
                          actor={m.user}
                          initials={(m.user.split("@")[0] ?? "?").slice(0, 2)}
                        />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm text-ink">
                          {displayNameForInGroup(m.user, groupId())}
                        </span>
                        <span class="block truncate text-xs text-faint">
                          @{m.user.split("@")[0]}
                        </span>
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="flex items-center gap-[9px] rounded-md border-[1.5px] border-border-strong bg-surface px-3 py-2 focus-within:(outline outline-2 outline-accent outline-offset-1)">
              <button
                type="button"
                class="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm text-faint transition-colors hover:text-ink disabled:opacity-50"
                data-testid="attach-button"
                disabled={uploading()}
                onClick={() => fileInput?.click()}
                aria-label="Attach a file"
              >
                <Icon name="plus" size={18} />
              </button>
              <input
                ref={fileInput}
                type="file"
                class="hidden"
                data-testid="file-input"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file) void onPickFile(file);
                }}
              />
              <textarea
                ref={inputRef}
                class="flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-faint"
                classList={{
                  "max-h-40 min-h-6": kind() === "message",
                  "min-h-20": kind() === "memo",
                }}
                rows={1}
                data-testid="composer-input"
                placeholder={
                  kind() === "memo"
                    ? "Share a memo…"
                    : `Message #${props.channel.name ?? props.channel.id}…`
                }
                value={text()}
                onInput={(e) => onType(e.currentTarget.value)}
                onSelect={(e) => refreshMentionQuery(e.currentTarget.value)}
                onBlur={() => {
                  stopTyping();
                  // Close the dropdown on blur; row onMouseDown preventDefault keeps
                  // a click from blurring before it registers.
                  setMentionQ(null);
                }}
                onKeyDown={(e) => {
                  // Autocomplete keys take precedence over Enter-to-send.
                  if (mentionQ() && candidates().length > 0) {
                    const n = candidates().length;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setMentionIdx((i) => (i + 1) % n);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionIdx((i) => (i - 1 + n) % n);
                      return;
                    }
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      const pick = candidates()[mentionIdx()];
                      if (pick) acceptMention(pick);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setMentionQ(null);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey && kind() === "message") {
                    e.preventDefault();
                    doSend();
                  }
                }}
              />
              <button
                type="button"
                class="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm text-faint transition-colors hover:text-ink"
                data-testid="emoji-button"
                aria-label="Add emoji"
                tabindex={-1}
              >
                <Icon name="smile" size={18} />
              </button>
              <button
                type="button"
                class="btn-accent shrink-0 px-2.5 py-[5px] text-[11px]"
                data-testid="send-button"
                onClick={doSend}
              >
                <Icon name="send" size={14} />
                {kind() === "memo" ? "Post" : "Send"}
              </button>
            </div>
          </div>
        </Match>
      </Switch>
      <Show when={sendError()}>
        <p class="mt-1 text-xs text-danger" data-testid="composer-error">
          {sendError()}
        </p>
      </Show>

      <Show when={editorOpen()}>
        <ArticleEditorOverlay
          channelName={channelName()}
          initialBody={editorPrefill()}
          promotedFrom={promotedFromChannel()}
          onClose={() => {
            setEditorOpen(false);
            clearPromote();
          }}
          onPublish={publishArticle}
        />
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Short HH:MM time for a message timestamp; empty when absent/unparseable. */

// Re-export so a parent can read the store reactively if needed.
export { chat };
// Re-export the shared `AttachmentView` so the home feed keeps importing it here.
export { AttachmentView };
