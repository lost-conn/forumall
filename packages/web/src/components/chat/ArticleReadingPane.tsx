/**
 * ArticleReadingPane (§5.3 / §7.2) — the dedicated reading view for an `article`
 * message, shown in the channel's main pane when an article is opened from the
 * stream. Renders the title (first heading of the markdown), author + tags, the
 * sanitized markdown body, a reaction bar, the thread of replies, and a reply
 * composer that posts a reply referencing the article.
 */
import { type Component, For, Show, createMemo, createSignal, onMount } from "solid-js";
import { renderMarkdown } from "../../lib/markdown.ts";
import { type ChatMessage, reactionsFor } from "../../stores/chat.ts";
import { session, sessionWs } from "../../stores/session.ts";
import { Icon } from "../Icon.tsx";
import { addReactionCmd, removeReactionCmd, sendMessage } from "./chat-controller.ts";

/** The promote-lineage tag marker (mirrors ChatView). */
const PROMOTE_TAG_PREFIX = "promoted-from:";

/** Local-part of an actor handle (full as fallback). */
function displayName(actor: string): string {
  const at = actor.indexOf("@");
  return at > 0 ? actor.slice(0, at) : actor;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Split an article's markdown into a leading title (first heading) + the body. */
export function splitArticle(md: string): { title: string; body: string } {
  const lines = (md ?? "").split("\n");
  const idx = lines.findIndex((l) => /^#{1,3}\s+/.test(l.trim()));
  if (idx === -1) {
    const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "Untitled article";
    return { title: firstNonEmpty.trim().slice(0, 120), body: md };
  }
  const title = (lines[idx] ?? "").replace(/^#{1,3}\s+/, "").trim();
  const body = [...lines.slice(0, idx), ...lines.slice(idx + 1)].join("\n").trim();
  return { title: title || "Untitled article", body };
}

const QUICK_REACTIONS: { key: string; unicode: string }[] = [
  { key: "+1", unicode: "👍" },
  { key: "heart", unicode: "❤️" },
  { key: "tada", unicode: "🎉" },
];

export const ArticleReadingPane: Component<{
  article: ChatMessage;
  /** Long-form kind being read. Memos render as a plain post (no markdown title);
   *  articles render their markdown title + body. Defaults to "article". */
  kind?: "article" | "memo";
  groupId: string;
  channelId: string;
  canPost: boolean;
  replies: () => ChatMessage[];
  onLoadReplies: () => void;
  onBack: () => void;
}> = (props) => {
  const a = () => props.article;
  const kind = () => props.kind ?? "article";
  const parts = createMemo(() => splitArticle(a().content.text ?? ""));
  const promotedFrom = createMemo(() => {
    const t = a().tags?.find((x) => x.startsWith(PROMOTE_TAG_PREFIX));
    return t ? t.slice(PROMOTE_TAG_PREFIX.length) : undefined;
  });
  const otherTags = () => (a().tags ?? []).filter((t) => !t.startsWith(PROMOTE_TAG_PREFIX));

  onMount(() => props.onLoadReplies());

  const reactions = () => reactionsFor(props.channelId, a().id);
  const myKeys = createMemo(
    () =>
      new Set(
        reactions()
          .filter((g) => session.actor != null && g.authors.includes(session.actor))
          .map((g) => g.key),
      ),
  );
  const [showPicker, setShowPicker] = createSignal(false);
  const toggleReaction = (key: string, unicode: string): void => {
    const ws = sessionWs();
    if (!ws) return;
    const common = {
      ws,
      groupId: props.groupId,
      channelId: props.channelId,
      messageId: a().id,
      key,
    };
    if (myKeys().has(key)) removeReactionCmd(common);
    else addReactionCmd({ ...common, unicode });
    setShowPicker(false);
  };

  const [replyText, setReplyText] = createSignal("");
  const sendReply = (): void => {
    const ws = sessionWs();
    const body = replyText().trim();
    if (!ws || body.length === 0) return;
    sendMessage({
      ws,
      groupId: props.groupId,
      channelId: props.channelId,
      author: session.actor ?? "",
      text: body,
      type: "message",
      reference: { type: "reply", id: a().id },
    });
    setReplyText("");
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="article-reading">
      {/* Header */}
      <header class="flex items-center gap-3 border-b border-border px-6 py-3">
        <button
          type="button"
          class="btn-ghost px-3 py-1.5 text-xs"
          data-testid="article-back"
          onClick={() => props.onBack()}
        >
          <Icon name="reply" size={14} />
          Back to channel
        </button>
        <span class="fa-meta flex items-center gap-1.5">
          <Icon name={kind() === "memo" ? "memo" : "article"} size={13} />
          {kind()}
        </span>
        <button
          type="button"
          class="ml-auto grid h-[30px] w-[30px] place-items-center rounded-sm text-muted hover:(bg-surface-2 text-ink)"
          title="More"
          aria-label="More options"
          tabindex={-1}
        >
          <Icon name="more" size={18} />
        </button>
      </header>

      {/* Body */}
      <div class="min-h-0 flex-1 overflow-auto px-6 py-6 fa-scroll">
        <div class="mx-auto max-w-3xl">
          <Show when={promotedFrom()}>
            {(from) => (
              <div
                class="mb-3 inline-flex items-center gap-1.5 rounded-sm border-[1.5px] border-dashed border-ember bg-ember-soft px-2 py-0.5 text-[11px] font-mono uppercase tracking-wide text-ember"
                data-testid="promote-lineage"
              >
                <Icon name="hash" size={12} />
                promoted from {from()}
              </div>
            )}
          </Show>

          <Show when={kind() === "article"}>
            <h1 class="fa-h1 mb-3" data-testid="article-title">
              {parts().title}
            </h1>
          </Show>

          <div class="mb-5 flex flex-wrap items-center gap-2">
            <span class="fa-ava fa-ava--sm">
              {displayName(a().author).slice(0, 1).toUpperCase()}
            </span>
            <span class="font-mono text-[13px] text-ink">{displayName(a().author)}</span>
            <span class="fa-meta">{formatTime(a().createdAt)}</span>
            <For each={otherTags()}>{(t) => <span class="fa-tag">{t}</span>}</For>
          </div>

          {/* Articles render sanitized markdown (XSS-safe: escapes input,
              allowlists schemes); memos render as plain text. */}
          <Show
            when={kind() === "article"}
            fallback={
              <p
                class="whitespace-pre-wrap break-words text-sm text-ink"
                data-testid="article-body"
              >
                {a().content.text ?? ""}
              </p>
            }
          >
            <div
              class="prose-chat text-sm text-ink"
              data-testid="article-body"
              innerHTML={renderMarkdown(parts().body)}
            />
          </Show>

          {/* Reactions */}
          <div class="fa-rx mt-6">
            <For each={reactions()}>
              {(g) => (
                <button
                  type="button"
                  class="fa-rx__chip"
                  classList={{ "fa-rx__chip--on": myKeys().has(g.key) }}
                  onClick={() => toggleReaction(g.key, g.unicode ?? g.key)}
                >
                  <span>{g.unicode ?? g.key}</span>
                  <span>{g.authors.length}</span>
                </button>
              )}
            </For>
            <div class="relative">
              <button
                type="button"
                class="fa-rx__chip fa-rx__add"
                aria-label="Add reaction"
                onClick={() => setShowPicker((v) => !v)}
              >
                <Icon name="smile" size={13} />
              </button>
              <Show when={showPicker()}>
                <div class="absolute bottom-full left-0 z-10 mb-1 flex gap-0.5 rounded-md border-[1.5px] border-border-strong bg-surface p-1">
                  <For each={QUICK_REACTIONS}>
                    {(r) => (
                      <button
                        type="button"
                        class="rounded px-1 py-0.5 text-sm hover:bg-surface-2"
                        onClick={() => toggleReaction(r.key, r.unicode)}
                      >
                        {r.unicode}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>

          <div class="fa-divider fa-divider--dashed my-6" />

          {/* Replies */}
          <div class="eyebrow mb-3" data-testid="article-replies-count">
            {props.replies().length} {props.replies().length === 1 ? "reply" : "replies"}
          </div>
          <ul class="flex flex-col gap-4">
            <For each={props.replies()}>
              {(r) => (
                <li class="flex gap-3" data-testid="article-reply">
                  <span class="fa-ava fa-ava--sm">
                    {displayName(r.author).slice(0, 1).toUpperCase()}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="font-mono text-[13px] text-ink">{displayName(r.author)}</span>
                      <span class="fa-meta">{formatTime(r.createdAt)}</span>
                    </div>
                    <p class="whitespace-pre-wrap break-words text-sm text-ink">
                      {r.content.text ?? ""}
                    </p>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>

      {/* Reply composer */}
      <Show when={props.canPost}>
        <div class="border-t border-border px-6 py-3">
          <div class="flex items-end gap-2.5 rounded-md border-[1.5px] border-border-strong bg-surface px-3 py-2 focus-within:(outline outline-2 outline-accent outline-offset-1)">
            <span class="pb-0.5 text-faint">
              <Icon name="reply" size={16} />
            </span>
            <textarea
              class="flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-faint"
              rows={1}
              data-testid="article-reply-input"
              placeholder={`Reply to this ${kind()}…`}
              value={replyText()}
              onInput={(e) => setReplyText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendReply();
                }
              }}
            />
            <button
              type="button"
              class="btn-accent shrink-0 px-4 py-2 text-xs"
              data-testid="article-reply-send"
              onClick={sendReply}
            >
              <Icon name="send" size={14} />
              Reply
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
};
