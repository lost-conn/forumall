/**
 * The channel composer (§7.1 `message.create`): message / memo / article kinds,
 * @mention autocomplete, attachments (uploaded to the home provider for the
 * channel's provider, §5.8), reply and promote context, and typing signals.
 */
import type { Channel, Member } from "@forumall/shared";
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
} from "solid-js";
import { COMPOSED_MIME } from "../../lib/content/body.ts";
import { listMembers } from "../../lib/groups-api.ts";
import { detectActiveMentionQuery, mentionRefFor } from "../../lib/mentions.ts";
import { PROMOTE_TAG_PREFIX } from "../../lib/promote-tag.ts";
import type { ChatMessage } from "../../stores/chat.ts";
import { displayNameForInGroup } from "../../stores/profiles.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { AttachmentChips } from "../shared/AttachmentChips.tsx";
import { ReplyContextPill } from "../shared/ReplyContextPill.tsx";
import { useComposerTyping, useComposerUpload } from "../shared/composer.ts";
import { Avatar } from "../social/Avatar.tsx";
import { ArticleEditorOverlay } from "./ArticleEditorOverlay.tsx";
import { sendMessage, typingStart, typingStop } from "./chat-controller.ts";

/** Throttle window for `typing.start` re-emits while composing (ms). */
const TYPING_THROTTLE_MS = 2500;
/** Idle window after the last keystroke before emitting `typing.stop` (ms). */
const TYPING_IDLE_MS = 3000;

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

type ComposeKind = "message" | "memo" | "article";

export const ChatComposer: Component<{
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
  // §5.8: attachments are uploaded (to the home provider) with the channel's
  // provider as their target: the provider this socket is to.
  const {
    pendingAttachments,
    attachmentsForSend,
    clearAttachments,
    uploading,
    error: sendError,
    setError: setSendError,
    onPickFile,
    removeAttachment,
    setFileInput,
    openFilePicker,
  } = useComposerUpload(() => sessionWs()?.host ?? null);
  /** A send is preparing its attachments; a second Enter must not send twice. */
  let preparing = false;
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
      mime: COMPOSED_MIME,
      ...(tags.length > 0 ? { tags } : {}),
    });
    setEditorOpen(false);
    setKind("message");
    clearPromote();
  };

  const { notifyTyping, stopTyping } = useComposerTyping({
    start: () => {
      const ws = sessionWs();
      if (ws) typingStart(ws, channelId());
    },
    stop: () => {
      const ws = sessionWs();
      if (ws) typingStop(ws, channelId());
    },
    throttleMs: TYPING_THROTTLE_MS,
    idleMs: TYPING_IDLE_MS,
  });

  const onType = (value: string): void => {
    setText(value);
    refreshMentionQuery(value);
    notifyTyping();
  };

  const doSend = (): void => {
    const ws = sessionWs();
    if (preparing || !ws) return;
    const k = kind();
    const body = text().trim();
    if (body.length === 0 && pendingAttachments().length === 0) return;
    setSendError(null);
    // Capture the destination now: the attachments may need uploading again
    // first, and the composer outlives a switch of channel.
    const gid = groupId();
    const cid = channelId();
    const target = props.replyTarget();
    preparing = true;
    void attachmentsForSend()
      .finally(() => {
        preparing = false;
      })
      .then((atts) => {
        sendMessage({
          ws,
          groupId: gid,
          channelId: cid,
          author: session.actor ?? "",
          text: body,
          type: k,
          mime: COMPOSED_MIME,
          ...(target ? { reference: { type: "reply", id: target.id } } : {}),
          attachments: atts,
        });
        setText("");
        setKind("message");
        clearAttachments();
        props.onClearReply();
        clearPromote();
        stopTyping();
      })
      .catch((err) => {
        setSendError(err instanceof Error ? err.message : "Could not attach the files.");
      });
  };

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
        onRemove={removeAttachment}
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
                onClick={openFilePicker}
                aria-label="Attach a file"
              >
                <Icon name="plus" size={18} />
              </button>
              <input
                ref={setFileInput}
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
