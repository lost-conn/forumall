/**
 * One message in a channel stream, as {@link ChatView} renders it: the node (a
 * message plus its optional quoted-parent reference), the row (author, time,
 * reactions, edit / delete / reply affordances, send status), the kind-aware
 * body (`message` / `memo` text, an `article` card, a best-effort fallback for
 * an unknown `type`, §5.3 / §2.3), and the typing line under the stream.
 * `MessageBody` is shared with the home feed.
 */
import {
  type Accessor,
  type Component,
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
} from "solid-js";
import { formatTime } from "../../lib/time.ts";
import { type ChatMessage, type ReactionGroup, reactionsFor } from "../../stores/chat.ts";
import { displayNameForInGroup, initialsFor } from "../../stores/profiles.ts";
import { session, sessionWs } from "../../stores/session.ts";
import { Icon } from "../Icon.tsx";
import { AttachmentList } from "../shared/AttachmentList.tsx";
import { EditMessageForm } from "../shared/EditMessageForm.tsx";
import { MessageStatus } from "../shared/MessageStatus.tsx";
import { ReactionBar, ReactionPicker } from "../shared/Reactions.tsx";
import { ReplyQuote } from "../shared/ReplyQuote.tsx";
import { RichText } from "../shared/RichText.tsx";
import { Avatar } from "../social/Avatar.tsx";
import { openUserProfile } from "../social/user-profile-store.ts";
import { splitArticle } from "./ArticleReadingPane.tsx";
import {
  addReactionCmd,
  deleteMessage,
  editMessage,
  removeReactionCmd,
  retrySend,
} from "./chat-controller.ts";
import { PROMOTE_TAG_PREFIX } from "./promote.ts";

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

// ---------------------------------------------------------------------------
// Message node (a channel message + an optional quoted-parent reference)
// ---------------------------------------------------------------------------

export const MessageNode: Component<{
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

export const TypingLine: Component<{ actors: string[]; groupId: string }> = (props) => (
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
