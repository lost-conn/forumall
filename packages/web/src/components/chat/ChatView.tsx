/**
 * ChatView (P8) — the real-time chat experience for one text channel.
 *
 * Renders the message timeline (history + live, de-duped, with tombstones +
 * in-place edits), a composer (optimistic local echo, attachments, typing), and
 * per-message reactions, edit/delete affordances. Wires the live
 * {@link OfscpWsClient} into the chat store via {@link openChannel} and the
 * command helpers.
 *
 * Message-type rendering (§5.3 / §2.3 forward-compat):
 *  - `message` / `memo` → plain text,
 *  - `article` → sanitized markdown,
 *  - unknown `type` → generic best-effort text fallback (never crashes).
 */
import type { Attachment, Channel } from "@forumall/shared";
import {
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
import {
  type ChannelHandle,
  addReactionCmd,
  deleteMessage,
  editMessage,
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

export const ChatView: Component<{ channel: Channel; canPost: boolean; canModerate: boolean }> = (
  props,
) => {
  const channelId = () => props.channel.id;
  const groupId = () => props.channel.groupId;

  const [handle, setHandle] = createSignal<ChannelHandle | null>(null);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [historyError, setHistoryError] = createSignal<string | null>(null);

  // (Re)open the channel whenever it changes. Tear down the previous wiring.
  createEffect(
    on(channelId, (id) => {
      const client = sessionClient();
      const ws = sessionWs();
      setHistoryError(null);
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
  // Auto-scroll to the newest message when the timeline grows (and we were near
  // the bottom). Keyed off the message count so each append nudges us down.
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
      <header class="flex items-center gap-2 border-b border-border px-6 py-3">
        <span class="text-faint">#</span>
        <h2 class="text-sm font-semibold tracking-tight" data-testid="chat-channel-name">
          {props.channel.name ?? props.channel.id}
        </h2>
        <Show when={props.channel.topic}>
          <span class="truncate text-xs text-faint">— {props.channel.topic}</span>
        </Show>
      </header>

      <div ref={scrollEl} class="min-h-0 flex-1 overflow-auto px-6 py-4" data-testid="message-list">
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
          when={messages().length > 0}
          fallback={
            <p class="text-sm text-muted" data-testid="chat-empty">
              No messages yet. Say hello.
            </p>
          }
        >
          <ul class="flex flex-col gap-3">
            <For each={messages()}>
              {(msg) => (
                <MessageRow
                  message={msg}
                  channelId={channelId()}
                  groupId={groupId()}
                  canModerate={props.canModerate}
                  reactions={() => reactionsFor(channelId(), msg.id)}
                />
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
            class="border-t border-border px-6 py-3 text-xs text-faint"
            data-testid="chat-readonly"
          >
            You don't have permission to post in this channel.
          </div>
        }
      >
        <Composer channel={props.channel} />
      </Show>
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
  reactions: () => ReactionGroup[];
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
    });
    // The server reports an expired edit-window (403) etc. as an `error` event
    // echoing our command's id in `correlationId`. Listen once: surface the
    // message + keep the editor open, otherwise close on the matching success.
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
    <li
      class="group/msg flex flex-col gap-1"
      data-testid="message-row"
      data-message-id={m().id}
      data-pending={m().pending ? "1" : undefined}
    >
      <div class="flex items-baseline gap-2">
        <span class="text-xs font-semibold text-ink" data-testid="message-author">
          {displayName(m().author)}
        </span>
        <span class="text-[10px] text-faint">{formatTime(m().createdAt)}</span>
        <Show when={m().editedAt && !isDeleted()}>
          <span class="text-[10px] text-faint" data-testid="message-edited">
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
          <MessageBody message={m()} />
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
        <div class="flex flex-wrap gap-1" data-testid="reactions">
          <For each={props.reactions()}>
            {(g) => (
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors"
                classList={{
                  "border-accent bg-accent-lo/20 text-ink": myReactionKeys().has(g.key),
                  "border-border bg-surface-2 text-muted hover:text-ink": !myReactionKeys().has(
                    g.key,
                  ),
                }}
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
    </li>
  );
};

/** Render a message body by §5.3 type, with a safe fallback for unknown types. */
const MessageBody: Component<{ message: ChatMessage }> = (props) => {
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
        {/* `renderMarkdown` HTML-escapes all input + allowlists link schemes, so
            the produced HTML is trusted/sanitized (see lib/markdown.ts). */}
        <div
          class="prose-chat text-sm text-ink"
          data-testid="message-article"
          innerHTML={renderMarkdown(text())}
        />
      </Match>
      <Match when={type() === "message" || type() === "memo"}>
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
    <div class="px-6 py-1 text-xs text-faint" data-testid="typing-indicator">
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

const Composer: Component<{ channel: Channel }> = (props) => {
  const channelId = () => props.channel.id;
  const groupId = () => props.channel.groupId;
  const [text, setText] = createSignal("");
  const [pendingAttachments, setPendingAttachments] = createSignal<Attachment[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);

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
    const body = text().trim();
    const atts = pendingAttachments();
    if (!ws || (body.length === 0 && atts.length === 0)) return;
    setSendError(null);
    try {
      sendMessage({
        ws,
        groupId: groupId(),
        channelId: channelId(),
        author: session.actor ?? "",
        text: body,
        attachments: atts,
      });
      setText("");
      setPendingAttachments([]);
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

  return (
    <div class="border-t border-border px-6 py-3" data-testid="composer">
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
      <div class="flex items-end gap-2">
        <button
          type="button"
          class="btn-ghost shrink-0 px-3 py-2 text-sm"
          data-testid="attach-button"
          disabled={uploading()}
          onClick={() => fileInput?.click()}
          aria-label="Attach a file"
        >
          {uploading() ? "…" : "📎"}
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
          class="input max-h-40 min-h-10 flex-1 resize-y"
          data-testid="composer-input"
          placeholder={`Message #${props.channel.name ?? props.channel.id}`}
          value={text()}
          onInput={(e) => onType(e.currentTarget.value)}
          onBlur={stopTyping}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              doSend();
            }
          }}
        />
        <button
          type="button"
          class="btn-accent shrink-0 px-4 py-2 text-sm"
          data-testid="send-button"
          onClick={doSend}
        >
          Send
        </button>
      </div>
      <Show when={sendError()}>
        <p class="mt-1 text-xs text-danger" data-testid="composer-error">
          {sendError()}
        </p>
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
