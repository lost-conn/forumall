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
 *  - replies to a **memo/article** are pulled OUT of the main flow and nested
 *    under their parent (always), with a lazy "load replies" expander;
 *  - replies to a **chat message** render inline with a quoted-parent snippet
 *    by default, or nested under the parent in "threaded" view (header toggle).
 */
import type { Attachment, Channel } from "@forumall/shared";
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
} from "solid-js";
import { isImageAttachment, resolveAttachmentUrl, uploadMedia } from "../../lib/chat-api.ts";
import { renderMarkdown } from "../../lib/markdown.ts";
import {
  type ChatMessage,
  type ReactionGroup,
  chat,
  messagesFor,
  olderCursorFor,
  reactionsFor,
  typingFor,
} from "../../stores/chat.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { FollowToggle } from "../feed/FollowToggle.tsx";
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

/** A small, friendly reaction palette for the quick-react button. */
const QUICK_REACTIONS: { key: string; unicode: string }[] = [
  { key: "+1", unicode: "👍" },
  { key: "heart", unicode: "❤️" },
  { key: "tada", unicode: "🎉" },
  { key: "eyes", unicode: "👀" },
  { key: "laugh", unicode: "😄" },
];

/** Throttle window for `typing.start` re-emits while composing (ms). */
const TYPING_THROTTLE_MS = 2500;
/** Idle window after the last keystroke before emitting `typing.stop` (ms). */
const TYPING_IDLE_MS = 3000;

/** Message kinds whose replies are pulled out of the main flow and nested. */
function isLongForm(type: string | undefined): boolean {
  return type === "memo" || type === "article";
}

/** Per-type tag metadata (label · icon · fa-type modifier) shown by name + time. */
const TYPE_META: Record<string, { label: string; icon: IconName; cls: string }> = {
  message: { label: "chat", icon: "chat", cls: "fa-type--chat" },
  memo: { label: "memo", icon: "memo", cls: "fa-type--memo" },
  article: { label: "article", icon: "article", cls: "fa-type--article" },
};

/** Tag marker carrying an article's promote lineage: `promoted-from:#channel`. */
const PROMOTE_TAG_PREFIX = "promoted-from:";

/** The source channel an article was promoted from, if its tags carry the marker. */
function promotedFrom(message: ChatMessage): string | undefined {
  const tag = message.tags?.find((t) => t.startsWith(PROMOTE_TAG_PREFIX));
  return tag ? tag.slice(PROMOTE_TAG_PREFIX.length) : undefined;
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
  const [threadMode, setThreadMode] = createSignal(false);
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

  const messages = createMemo(() => messagesFor(channelId()));
  const typingActors = createMemo(() => typingFor(channelId()).filter((u) => u !== session.actor));

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

  /** Is this message nested under its parent (hidden from the main flow)? */
  const isNested = (m: ChatMessage): boolean => {
    const pid = m.reference?.id;
    if (!pid) return false;
    const parent = byId().get(pid);
    if (!parent) return false; // orphan reply (parent out of window) → stays inline
    if (isLongForm(parent.type)) return true; // memo/article replies always nest
    return threadMode(); // chat replies nest only in threaded view
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

  let scrollEl: HTMLDivElement | undefined;
  createEffect(
    on(
      () => messages().length,
      () => {
        queueMicrotask(() => {
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
        });
      },
    ),
  );

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
                  <button
                    type="button"
                    class="btn-ghost px-2 py-1 text-xs"
                    data-testid="thread-toggle"
                    aria-pressed={threadMode()}
                    onClick={() => setThreadMode((v) => !v)}
                    title="Toggle threaded / inline reply view"
                  >
                    {threadMode() ? "Threaded" : "Inline"}
                  </button>
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

            <div
              ref={scrollEl}
              class="min-h-0 flex-1 overflow-auto px-[18px] pt-1.5 pb-3.5"
              data-testid="message-list"
            >
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
                        {/* Dashed separator between message groups (mirrors the
                            prototype's per-message `fa-divider--dashed`). */}
                        <Show when={index() > 0}>
                          <li aria-hidden="true" class="fa-divider fa-divider--dashed" />
                        </Show>
                        <MessageNode
                          message={msg}
                          depth={0}
                          channelId={channelId()}
                          groupId={groupId()}
                          canModerate={props.canModerate}
                          canPromote={(props.canPostArticle ?? props.canPost) === true}
                          byId={byId}
                          repliesByParent={repliesByParent}
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

            <TypingLine actors={typingActors()} />

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
// Message node (a message + its nested reply thread)
// ---------------------------------------------------------------------------

const MessageNode: Component<{
  message: ChatMessage;
  depth: number;
  channelId: string;
  groupId: string;
  canModerate: boolean;
  canPromote: boolean;
  byId: Accessor<Map<string, ChatMessage>>;
  repliesByParent: Accessor<Map<string, ChatMessage[]>>;
  onReply: (m: ChatMessage) => void;
  onPromote: (m: ChatMessage) => void;
  onOpenArticle: (m: ChatMessage) => void;
}> = (props) => {
  const m = () => props.message;
  const [expanded, setExpanded] = createSignal(props.depth === 0 && isLongForm(props.message.type));
  const [loadingReplies, setLoadingReplies] = createSignal(false);

  const loaded = () => props.repliesByParent().get(m().id) ?? [];
  // Show a "load replies" affordance when the server reports more replies than
  // we currently have loaded (parent + replies can be far apart in the window).
  const missingReplies = () => Math.max(0, (m().replyCount ?? 0) - loaded().length);

  const expandAndLoad = async (): Promise<void> => {
    setExpanded(true);
    if (missingReplies() > 0 && !loadingReplies()) {
      const client = sessionClient();
      if (!client) return;
      setLoadingReplies(true);
      try {
        await loadReplies({
          client,
          groupId: props.groupId,
          channelId: props.channelId,
          messageId: m().id,
        });
      } finally {
        setLoadingReplies(false);
      }
    }
  };

  const replyParent = () => {
    const pid = m().reference?.id;
    return pid ? props.byId().get(pid) : undefined;
  };

  return (
    <li
      class="flex flex-col gap-1"
      classList={{ "ml-4 border-l border-border pl-3": props.depth > 0 }}
    >
      <Show when={m().reference}>
        <ReplyQuote parent={replyParent()} />
      </Show>

      <MessageRow
        message={m()}
        channelId={props.channelId}
        groupId={props.groupId}
        canModerate={props.canModerate}
        canPromote={props.canPromote}
        reactions={() => reactionsFor(props.channelId, m().id)}
        onReply={() => props.onReply(m())}
        onPromote={() => props.onPromote(m())}
        onOpenArticle={() => props.onOpenArticle(m())}
      />

      {/* Nested replies (memo/article always; chat in threaded mode). */}
      <Show when={loaded().length > 0 || missingReplies() > 0}>
        <div class="mt-1 flex flex-col gap-2">
          <Show when={isLongForm(m().type) || missingReplies() > 0}>
            <button
              type="button"
              class="self-start text-xs text-accent hover:underline"
              data-testid="thread-expander"
              onClick={() => (expanded() ? setExpanded(false) : void expandAndLoad())}
            >
              {expanded()
                ? "Hide replies"
                : loadingReplies()
                  ? "Loading…"
                  : `Show ${m().replyCount ?? loaded().length} ${
                      (m().replyCount ?? loaded().length) === 1 ? "reply" : "replies"
                    }`}
            </button>
          </Show>
          <Show when={expanded()}>
            <ul class="flex flex-col gap-3">
              <For each={loaded()}>
                {(reply) => (
                  <MessageNode
                    message={reply}
                    depth={props.depth + 1}
                    channelId={props.channelId}
                    groupId={props.groupId}
                    canModerate={props.canModerate}
                    canPromote={props.canPromote}
                    byId={props.byId}
                    repliesByParent={props.repliesByParent}
                    onReply={props.onReply}
                    onPromote={props.onPromote}
                    onOpenArticle={props.onOpenArticle}
                  />
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </li>
  );
};

/** A small quoted snippet of the message being replied to (inline replies). */
const ReplyQuote: Component<{ parent?: ChatMessage }> = (props) => {
  const snippet = (): string => {
    const p = props.parent;
    if (!p) return "a message";
    if (p.deletedAt) return "a deleted message";
    const author = displayName(p.author);
    const text = (p.content.text ?? "").replace(/\s+/g, " ").trim();
    const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return clipped ? `${author}: ${clipped}` : author;
  };
  return (
    <div class="flex items-center gap-1 text-xs text-faint" data-testid="reply-quote">
      <span aria-hidden="true">↳</span>
      <span class="truncate">replying to {snippet()}</span>
    </div>
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
  const [showReactPicker, setShowReactPicker] = createSignal(false);

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
    setShowReactPicker(false);
  };

  return (
    <div
      class="group/msg flex gap-[11px]"
      data-testid="message-row"
      data-message-id={m().id}
      data-message-type={m().type ?? "message"}
      data-pending={m().pending ? "1" : undefined}
    >
      <button
        type="button"
        class="fa-ava transition-colors hover:border-accent"
        aria-label={`${displayName(m().author)} profile`}
        onClick={() => openUserProfile(m().author)}
      >
        {displayName(m().author).slice(0, 1).toUpperCase()}
      </button>
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="fa-msg__name hover:underline"
            data-testid="message-author"
            onClick={() => openUserProfile(m().author)}
          >
            {displayName(m().author)}
          </button>
          <span class="fa-meta">{formatTime(m().createdAt)}</span>
          <Show when={TYPE_META[m().type ?? "message"]}>
            {(meta) => (
              <span class={`fa-type ${meta().cls}`} data-testid="message-kind">
                <Icon name={meta().icon} size={11} />
                {meta().label}
              </span>
            )}
          </Show>
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

          {/* Hover actions */}
          <Show when={!isDeleted()}>
            <span class="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
              <button
                type="button"
                class="rounded px-1.5 py-0.5 text-xs text-faint hover:(bg-surface-2 text-ink)"
                data-testid="reply-button"
                onClick={() => props.onReply()}
              >
                Reply
              </button>
              <Show when={props.canPromote && (m().type ?? "message") === "message"}>
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 text-xs text-faint hover:(bg-surface-2 text-ember)"
                  data-testid="promote-button"
                  title="Promote this message to an article"
                  onClick={() => props.onPromote()}
                >
                  Promote
                </button>
              </Show>
              <div class="relative">
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 text-xs text-faint hover:(bg-surface-2 text-ink)"
                  data-testid="react-button"
                  onClick={() => setShowReactPicker((v) => !v)}
                  aria-label="Add reaction"
                >
                  ☺
                </button>
                <Show when={showReactPicker()}>
                  <div
                    class="absolute right-0 bottom-full z-10 mb-1 flex gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-lg"
                    data-testid="reaction-picker"
                  >
                    <For each={QUICK_REACTIONS}>
                      {(r) => (
                        <button
                          type="button"
                          class="rounded px-1 py-0.5 text-sm hover:bg-surface-2"
                          data-testid="reaction-pick"
                          data-reaction-key={r.key}
                          onClick={() => toggleReaction(r.key, r.unicode)}
                        >
                          {r.unicode}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <Show when={isAuthor()}>
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 text-xs text-faint hover:(bg-surface-2 text-ink)"
                  data-testid="edit-message"
                  onClick={startEdit}
                >
                  Edit
                </button>
              </Show>
              <Show when={isAuthor() || props.canModerate}>
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 text-xs text-faint hover:(bg-surface-2 text-danger)"
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
            <div class="flex flex-col gap-1">
              <textarea
                class="input min-h-16 resize-y"
                data-testid="edit-input"
                value={editText()}
                onInput={(e) => setEditText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitEdit();
                  }
                  if (e.key === "Escape") setEditing(false);
                }}
              />
              <div class="flex gap-2">
                <button
                  type="button"
                  class="btn-accent px-3 py-1 text-xs"
                  data-testid="save-edit"
                  onClick={submitEdit}
                >
                  Save
                </button>
                <button
                  type="button"
                  class="btn-ghost px-3 py-1 text-xs"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </div>
              <Show when={editError()}>
                <p class="text-xs text-danger" data-testid="edit-error">
                  {editError()}
                </p>
              </Show>
            </div>
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
        <Show when={props.reactions().length > 0}>
          <div class="fa-rx" data-testid="reactions">
            <For each={props.reactions()}>
              {(g) => (
                <button
                  type="button"
                  class="fa-rx__chip"
                  classList={{ "fa-rx__chip--on": myReactionKeys().has(g.key) }}
                  data-testid="reaction-chip"
                  data-reaction-key={g.key}
                  title={g.authors.map(displayName).join(", ")}
                  onClick={() => toggleReaction(g.key, g.unicode ?? g.key)}
                >
                  <span>{g.unicode ?? g.key}</span>
                  <span data-testid="reaction-count">{g.authors.length}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

/** Render a message body by §5.3 type, with a safe fallback for unknown types. */
const MessageBody: Component<{ message: ChatMessage; onOpenArticle?: () => void }> = (props) => {
  const text = () => props.message.content.text ?? "";
  const type = () => props.message.type ?? "message";
  return (
    <Switch
      fallback={
        // Unknown type (§2.3 forward-compat): best-effort plain text, never crash.
        <p class="text-sm text-ink whitespace-pre-wrap break-words" data-testid="message-text">
          {text()}
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
            {splitArticle(text())
              .body.replace(/[#>*`_-]/g, "")
              .replace(/\s+/g, " ")
              .trim()}
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
        {/* Memo renders as a phosphor-bordered card (social-style post). */}
        <div class="mt-1 rounded-md border-[1.5px] border-accent bg-surface p-3.5">
          <p class="text-sm text-ink whitespace-pre-wrap break-words" data-testid="message-text">
            {text()}
          </p>
        </div>
      </Match>
      <Match when={type() === "message"}>
        <p class="text-sm text-ink whitespace-pre-wrap break-words" data-testid="message-text">
          {text()}
        </p>
      </Match>
    </Switch>
  );
};

/** Render one attachment: images inline, everything else as a download link. */
const AttachmentView: Component<{ attachment: Attachment }> = (props) => {
  const url = () => resolveAttachmentUrl(props.attachment.url);
  return (
    <Show
      when={isImageAttachment(props.attachment)}
      fallback={
        <a
          href={url()}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted hover:text-ink"
          data-testid="attachment-link"
        >
          📎 {props.attachment.filename ?? props.attachment.id}
        </a>
      }
    >
      <a href={url()} target="_blank" rel="noopener noreferrer" data-testid="attachment-image-link">
        <img
          src={url()}
          alt={props.attachment.filename ?? "attachment"}
          class="max-h-64 max-w-xs rounded-lg border border-border object-contain"
          data-testid="attachment-image"
        />
      </a>
    </Show>
  );
};

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

const TypingLine: Component<{ actors: string[] }> = (props) => (
  <Show when={props.actors.length > 0}>
    <div class="px-[18px] py-1 text-xs text-faint" data-testid="typing-indicator">
      {typingText(props.actors)}
    </div>
  </Show>
);

function typingText(actors: string[]): string {
  const names = actors.map(displayName);
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
  const [text, setText] = createSignal("");
  const [kind, setKind] = createSignal<ComposeKind>("message");
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
          <div
            class="mb-2 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-xs"
            data-testid="composer-reply-pill"
          >
            <span class="truncate text-muted">
              Replying to <span class="text-ink">{displayName(t().author)}</span>
            </span>
            <button
              type="button"
              class="ml-auto text-faint hover:text-danger"
              aria-label="Cancel reply"
              data-testid="cancel-reply"
              onClick={() => props.onClearReply()}
            >
              ✕
            </button>
          </div>
        )}
      </Show>

      {/* Message-kind selector */}
      <div class="mb-[9px] flex items-center gap-[5px]" data-testid="compose-kind">
        {kindButton("message", "Message", "chat")}
        {kindButton("memo", "Memo", "memo", props.canPostMemo)}
        {kindButton("article", "Article", "article", props.canPostArticle)}
      </div>

      <Show when={pendingAttachments().length > 0}>
        <div class="mb-2 flex flex-wrap gap-2" data-testid="composer-attachments">
          <For each={pendingAttachments()}>
            {(att, idx) => (
              <span class="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">
                📎 {att.filename ?? att.id}
                <button
                  type="button"
                  class="text-faint hover:text-danger"
                  aria-label="Remove attachment"
                  onClick={() =>
                    setPendingAttachments((prev) => prev.filter((_, i) => i !== idx()))
                  }
                >
                  ✕
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>

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
              onBlur={stopTyping}
              onKeyDown={(e) => {
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

/** Display the local-part of an actor `handle@host` (full actor as a fallback). */
function displayName(actor: string): string {
  const at = actor.indexOf("@");
  return at > 0 ? actor.slice(0, at) : actor;
}

/** Short HH:MM time for a message timestamp; empty when absent/unparseable. */
function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Re-export so a parent can read the store reactively if needed.
export { chat };
