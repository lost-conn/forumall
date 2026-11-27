/**
 * One message in a DM thread, as the thread view renders it: author, time,
 * reactions, reply / edit / delete affordances, send status and the reply
 * listing affordance (§7.4), plus the body and the typing line.
 */
import type { Attachment } from "@forumall/shared";
import {
  type Accessor,
  type Component,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
} from "solid-js";
import { fetchDmReplies } from "../../lib/dm-api.ts";
import type { DmSentStore } from "../../lib/dm-store.ts";
import { formatFullTime, formatTime } from "../../lib/time.ts";
import { type DmMessage, dmReactionsFor, upsertDmMessage } from "../../stores/dms.ts";
import { displayNameFor } from "../../stores/profiles.ts";
import { session, sessionClient } from "../../stores/session.ts";
import { AttachmentList } from "../shared/AttachmentList.tsx";
import { EditMessageForm } from "../shared/EditMessageForm.tsx";
import { MessageStatus } from "../shared/MessageStatus.tsx";
import { ReactionBar, ReactionPicker } from "../shared/Reactions.tsx";
import { ReplyQuote } from "../shared/ReplyQuote.tsx";
import { RichText } from "../shared/RichText.tsx";
import { Avatar } from "../social/Avatar.tsx";
import { resolveDeliveryClient } from "./dm-delivery.ts";
import {
  DM_UNCONFIRMED_NOTICE,
  DM_UNCONFIRMED_SEND_NOTICE,
  DmUnconfirmedError,
} from "./dm-errors.ts";
import { deleteDm, editDm, toggleDmReaction } from "./dm-mutations.ts";
import { retrySendDm } from "./dm-send.ts";
import { isRemoteActor } from "./remote-actor.ts";

export const DmMessageRow: Component<{
  dmId: string;
  message: DmMessage;
  counterparty: string;
  sentStore: () => DmSentStore | null;
  byId: Accessor<Map<string, DmMessage>>;
  highlightId: Accessor<string | null>;
  onReply: (m: DmMessage) => void;
  onJumpTo: (id: string) => void;
}> = (props) => {
  const m = () => props.message;
  const mine = () => m().mine === true || m().author === session.actor;
  const isDeleted = () => m().deletedAt !== undefined;
  const [editing, setEditing] = createSignal(false);
  const [editText, setEditText] = createSignal("");
  const [editError, setEditError] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);

  const reactions = () => dmReactionsFor(props.dmId, m().id);
  const myReactionKeys = createMemo(
    () =>
      new Set(
        reactions()
          .filter((g) => session.actor != null && g.authors.includes(session.actor))
          .map((g) => g.key),
      ),
  );

  const replyParent = () => {
    const pid = m().reference?.id;
    return pid ? props.byId().get(pid) : undefined;
  };

  // Replies already flow into the DM timeline (they are inbox messages), but a
  // reply whose parent loaded in an earlier page may be outside the window. This
  // affordance ensures completeness: fetch this message's replies (§7.2) and fold
  // them in (de-duped by id). Shown when at least one loaded message replies here.
  const loadedReplies = createMemo(() =>
    [...props.byId().values()].filter((x) => x.reference?.id === m().id),
  );
  const viewReplies = (): void => {
    const client = sessionClient();
    const me = session.actor;
    if (!client || !me) return;
    setActionError(null);
    void fetchDmReplies(client, props.dmId, m().id, { limit: 50 })
      .then((page) => {
        for (const r of page.messages) {
          if (r.deletedAt) continue;
          upsertDmMessage(props.dmId, {
            id: r.id,
            author: r.author,
            content: r.content,
            ...(r.attachments && r.attachments.length > 0 ? { attachments: r.attachments } : {}),
            ...(r.reference ? { reference: r.reference } : {}),
            createdAt: r.createdAt,
            ...(r.editedAt ? { editedAt: r.editedAt } : {}),
            mine: r.author === me,
          });
        }
      })
      .catch((err) =>
        setActionError(err instanceof Error ? err.message : "Could not load replies."),
      );
  };

  const toggleReaction = (key: string, unicode: string): void => {
    const client = sessionClient();
    const me = session.actor;
    if (!client || !me) return;
    setActionError(null);
    // Storage-follows-message (§8.3), same routing as the edit/delete below —
    // but keyed on WHO WROTE this message, since either participant may react to
    // either side's: a message the caller SENT lives on the RECIPIENT's provider,
    // one they RECEIVED lives in their own inbox on the home provider.
    void resolveDeliveryClient(props.counterparty)
      .then((deliveryClient) =>
        toggleDmReaction({
          client,
          ...(deliveryClient ? { deliveryClient } : {}),
          dmId: props.dmId,
          messageId: m().id,
          messageAuthor: m().author,
          me,
          key,
          unicode,
          has: myReactionKeys().has(key),
        }),
      )
      .catch((err) =>
        setActionError(err instanceof Error ? err.message : "Could not update the reaction."),
      );
  };

  const startEdit = (): void => {
    setEditText(m().content.text ?? "");
    setEditError(null);
    setEditing(true);
  };
  const submitEdit = (): void => {
    const client = sessionClient();
    const store = props.sentStore();
    const me = session.actor;
    const text = editText().trim();
    if (!client || !store || !me || text.length === 0) return;
    setEditError(null);
    // Storage-follows-message (§8.3): a message the caller SENT lives on the
    // RECIPIENT's provider, so the edit is addressed there — the same delivery
    // client the send used (null → same provider → the home client).
    void resolveDeliveryClient(props.counterparty)
      .then((deliveryClient) =>
        editDm({
          client,
          ...(deliveryClient ? { deliveryClient } : {}),
          dmId: props.dmId,
          message: m(),
          me,
          text,
          sentStore: store,
        }),
      )
      .then(() => setEditing(false))
      .catch((err) => {
        // An unconfirmed outcome is NOT a failure: the optimistic edit is kept.
        // Stay in the editor (that's where `editError` renders) so the distinct
        // notice is visible and a re-submit is one click away.
        if (err instanceof DmUnconfirmedError) {
          setEditError(DM_UNCONFIRMED_NOTICE);
          return;
        }
        setEditError(err instanceof Error ? err.message : "Could not edit this message.");
      });
  };
  const doDelete = (): void => {
    const client = sessionClient();
    const store = props.sentStore();
    const me = session.actor;
    if (!client || !store || !me) return;
    if (!confirm("Delete this message?")) return;
    setActionError(null);
    // Same §8.3 routing as the edit above (`deleteDm` keeps a received message's
    // delete on the home provider — that copy lives in the caller's own inbox).
    void resolveDeliveryClient(props.counterparty)
      .then((deliveryClient) =>
        deleteDm({
          client,
          ...(deliveryClient ? { deliveryClient } : {}),
          dmId: props.dmId,
          message: m(),
          me,
          sentStore: store,
        }),
      )
      .catch((err) => {
        // As in `submitEdit`: an unconfirmed delete keeps its optimistic
        // tombstone, so say "couldn't confirm", not "couldn't delete".
        if (err instanceof DmUnconfirmedError) {
          setActionError(DM_UNCONFIRMED_NOTICE);
          return;
        }
        setActionError(err instanceof Error ? err.message : "Could not delete this message.");
      });
  };

  const retry = (): void => {
    const client = sessionClient();
    const store = props.sentStore();
    const me = session.actor;
    if (!client || !store || !me || !m().clientMessageId) return;
    const counterparty = props.counterparty;
    setActionError(null);
    void resolveDeliveryClient(counterparty)
      .then((deliveryClient) =>
        retrySendDm({
          client,
          ...(deliveryClient ? { deliveryClient } : {}),
          dmId: props.dmId,
          me,
          counterparty,
          text: m().content.text ?? "",
          ...(m().attachments && (m().attachments as Attachment[]).length > 0
            ? { attachments: m().attachments }
            : {}),
          ...(m().reference ? { reference: m().reference } : {}),
          sentStore: store,
          // The ORIGINAL idempotency key: a retry of a send that had in fact
          // committed dedupes on the recipient's provider instead of delivering
          // the message a second time (see `retrySendDm`).
          clientMessageId: m().clientMessageId as string,
        }),
      )
      .catch((err) => {
        // `retrySendDm` replaces this row's echo synchronously, so a rejection
        // AFTER that point is already reflected by the new echo (failed → the
        // retry button returns; unconfirmed → it stays "sending…"). This still
        // catches — an unhandled rejection otherwise — and surfaces the reason
        // for a failure BEFORE the re-send starts (e.g. resolving the recipient's
        // provider), where this row is still mounted.
        if (err instanceof DmUnconfirmedError) {
          setActionError(DM_UNCONFIRMED_SEND_NOTICE);
          return;
        }
        setActionError(err instanceof Error ? err.message : "Could not send this message.");
      });
  };

  return (
    <li
      class="group/dm -mx-1.5 flex flex-col gap-1 rounded-md px-1.5 transition-colors duration-500"
      classList={{
        "items-end": mine(),
        "bg-accent/10 ring-1 ring-accent/30 duration-150": props.highlightId() === m().id,
      }}
      data-testid="dm-message"
      data-message-id={m().id}
      data-mine={mine() ? "1" : "0"}
      data-message-highlighted={props.highlightId() === m().id ? "1" : undefined}
      data-pending={m().pending ? "1" : undefined}
    >
      <Show when={m().reference}>
        <ReplyQuote
          parent={
            replyParent()
              ? {
                  id: (replyParent() as DmMessage).id,
                  authorName: displayNameFor((replyParent() as DmMessage).author),
                  text: (replyParent() as DmMessage).content.text ?? "",
                  deleted: (replyParent() as DmMessage).deletedAt !== undefined,
                }
              : undefined
          }
          onJump={props.onJumpTo}
        />
      </Show>

      <div class="flex items-start gap-[9px]" classList={{ "flex-row-reverse": mine() }}>
        <Show when={!mine()}>
          <span class="fa-ava fa-ava--sm" classList={{ "fa-ava__fed": isRemoteActor(m().author) }}>
            <Avatar actor={m().author} />
          </span>
        </Show>
        <div class="flex max-w-[70%] flex-col gap-1" classList={{ "items-end": mine() }}>
          <Switch>
            <Match when={isDeleted()}>
              <p
                class="rounded-md border-[1.5px] border-border px-[13px] py-[9px] text-sm italic text-faint"
                data-testid="dm-message-tombstone"
              >
                message deleted
              </p>
            </Match>
            <Match when={editing()}>
              <EditMessageForm
                fullWidth
                testidPrefix="dm-"
                value={editText()}
                onInput={setEditText}
                onSubmit={submitEdit}
                onCancel={() => setEditing(false)}
                error={editError()}
              />
            </Match>
            <Match when={true}>
              <div
                class="rounded-md border-[1.5px] px-[13px] py-[9px]"
                classList={{
                  "border-accent bg-accent-soft text-ink": mine(),
                  "border-border-strong bg-surface text-ink": !mine(),
                }}
                data-testid="dm-message-bubble"
              >
                <DmMessageBody message={m()} />
              </div>
            </Match>
          </Switch>

          {/* Attachments */}
          <Show when={!isDeleted() && (m().attachments?.length ?? 0) > 0}>
            <AttachmentList attachments={m().attachments ?? []} testid="dm-attachments" />
          </Show>

          {/* Reactions */}
          <ReactionBar
            reactions={reactions}
            myKeys={myReactionKeys}
            onToggle={toggleReaction}
            resolveName={displayNameFor}
          />

          {/* Per-message actions — hover-revealed on desktop, always on touch. */}
          <Show when={!isDeleted() && !editing()}>
            <span class="flex items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover/dm:opacity-100">
              <button
                type="button"
                class="btn-action"
                data-testid="dm-reply-button"
                onClick={() => props.onReply(m())}
              >
                Reply
              </button>
              <ReactionPicker onPick={toggleReaction} />
              <Show when={loadedReplies().length > 0}>
                <button
                  type="button"
                  class="btn-action-accent"
                  data-testid="dm-view-replies"
                  onClick={viewReplies}
                >
                  {loadedReplies().length} replies
                </button>
              </Show>
              <Show when={mine()}>
                <button
                  type="button"
                  class="btn-action"
                  data-testid="dm-edit-message"
                  onClick={startEdit}
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="btn-action-danger"
                  data-testid="dm-delete-message"
                  onClick={doDelete}
                >
                  Delete
                </button>
              </Show>
            </span>
          </Show>

          <Show when={formatTime(m().createdAt)}>
            <span
              class="fa-meta"
              data-testid="dm-message-time"
              title={formatFullTime(m().createdAt)}
            >
              {formatTime(m().createdAt)}
              <Show when={m().editedAt && !isDeleted()}>
                {" "}
                <span data-testid="dm-message-edited">(edited)</span>
              </Show>
            </span>
          </Show>

          <MessageStatus
            pending={m().pending}
            failed={m().failed}
            onRetry={retry}
            testidPrefix="dm-"
            pendingColor="text-accent"
          />

          <Show when={actionError()}>
            <p class="text-[10px] text-danger" data-testid="dm-action-error">
              {actionError()}
            </p>
          </Show>
        </div>
      </div>
    </li>
  );
};

/**
 * Render a DM message body. DM messages are always `type: "message"` (the server
 * stores no other kind), so this renders content with the shared inline
 * formatter (`RichText`) — the same bold/italic/code/link + clickable-mention
 * rendering channel chat uses for `message`/`memo`. (Block markdown is reserved
 * for `article`-type messages, which DMs never carry.)
 */
const DmMessageBody: Component<{ message: DmMessage }> = (props) => (
  <p class="whitespace-pre-wrap break-words text-sm leading-[1.45]" data-testid="dm-message-text">
    <RichText text={props.message.content.text ?? ""} />
  </p>
);

/** Typing indicator for the counterparty (mirrors the channel typing line). */
export const DmTypingLine: Component<{ actors: string[] }> = (props) => (
  <Show when={props.actors.length > 0}>
    <div class="px-6 py-1 text-xs text-faint" data-testid="dm-typing-indicator">
      {dmTypingText(props.actors)}
    </div>
  </Show>
);

function dmTypingText(actors: string[]): string {
  const names = actors.map((a) => displayNameFor(a));
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}
