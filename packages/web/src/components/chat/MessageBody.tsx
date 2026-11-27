/**
 * A channel message's content in the stream (and the home feed), by type.
 *
 * The body itself is always rendered by its `content.mime`, never by type
 * (§5.3 *Content formats*); the type only picks the frame around it:
 *
 * - `message` (and any unknown type, §2.3): the body, then its unreferenced
 *   attachments.
 * - `memo`: the same inside a card, with a button that opens the reading pane.
 * - `article`: a card with the cover, the title (§5.3 title rule), a plain-text
 *   summary and the tags; the body itself is read in the reading pane.
 */
import { type Component, For, Match, Show, Switch, createMemo } from "solid-js";
import { articleSummary, articleView, attachmentLayout } from "../../lib/content/body.ts";
import { promotedFrom, topicTags } from "../../lib/promote-tag.ts";
import type { ChatMessage } from "../../stores/chat.ts";
import { Icon } from "../Icon.tsx";
import { AttachmentView } from "../shared/AttachmentView.tsx";
import { MessageContent, useParsedBody } from "../shared/BodyContent.tsx";

/** The stream's card for an article: cover, title, summary, tags. */
const ArticleCard: Component<{ message: ChatMessage; onOpenArticle?: () => void }> = (props) => {
  const body = useParsedBody(() => props.message);
  const view = createMemo(() => articleView(props.message, body()));
  const cover = createMemo(
    () => attachmentLayout(props.message, body().referencedAttachmentIds).cover,
  );
  return (
    <div class="mt-0.5 rounded-md border-[1.5px] border-border-strong bg-surface px-3.5 py-3.5">
      <Show when={promotedFrom(props.message.tags)}>
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
      <Show when={cover()}>
        {(att) => (
          <div class="mb-2" data-testid="article-cover">
            <AttachmentView attachment={att()} />
          </div>
        )}
      </Show>
      <button
        type="button"
        class="block text-left font-display text-base font-semibold text-ink transition-colors hover:text-accent"
        classList={{ "italic text-muted": view().title === null }}
        data-testid="open-article"
        onClick={() => props.onOpenArticle?.()}
      >
        {view().title ?? "Untitled article"}
      </button>
      <p class="my-[7px] mb-[11px] line-clamp-3 text-sm text-muted" data-testid="message-article">
        {articleSummary(props.message, view())}
      </p>
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <div class="flex flex-wrap items-center gap-[7px]">
          <For each={topicTags(props.message.tags)}>{(t) => <span class="fa-tag">{t}</span>}</For>
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
  );
};

/** Render a channel message's content by §5.3 type, with a safe fallback. */
export const MessageBody: Component<{ message: ChatMessage; onOpenArticle?: () => void }> = (
  props,
) => {
  const type = () => props.message.type ?? "message";
  const plain = () => (
    <MessageContent
      message={props.message}
      class="text-sm text-ink"
      testid="message-text"
      attachmentsTestid="attachments"
    />
  );
  return (
    // Unknown type (§2.3 forward-compat): rendered as a plain message.
    <Switch fallback={plain()}>
      <Match when={type() === "article"}>
        <ArticleCard message={props.message} onOpenArticle={props.onOpenArticle} />
      </Match>
      <Match when={type() === "memo"}>
        {/* A memo is a phosphor-bordered card (social-style post). Its body can
            hold links and blocks, so the card is not itself a button; the
            footer button opens the reading pane, where its replies live. */}
        <div class="mt-1 rounded-md border-[1.5px] border-accent bg-surface p-3.5">
          {plain()}
          <button
            type="button"
            class="mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-accent hover:underline"
            data-testid="open-memo"
            onClick={() => props.onOpenArticle?.()}
          >
            <Icon name="reply" size={12} />
            {props.message.replyCount ? `${props.message.replyCount} replies` : "Open memo"}
          </button>
        </div>
      </Match>
    </Switch>
  );
};
