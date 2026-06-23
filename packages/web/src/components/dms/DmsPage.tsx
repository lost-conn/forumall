/**
 * Direct-messages screen (P8, spec §7.4 / §8.3).
 *
 * A left rail listing the caller's DM conversations — merged from the server
 * (`GET /api/me/dms`, reconstructed from the caller's inbox) with locally-known
 * conversations (ones the caller has only SENT to, retained in the local
 * sent-store) — plus a "new DM" entry point. The right pane is the selected
 * thread: the merged timeline of RECEIVED (server inbox) + locally-retained SENT
 * messages, ordered by `createdAt`, with a live `dm.message` subscription and a
 * composer.
 *
 * Route-driven: `/dms` shows the list with an empty state; `/dms/{dmId}` opens a
 * thread. A small trust-boundary notice makes the §8.3 confidentiality model
 * explicit (DMs are readable by the recipient's provider; not E2E-encrypted).
 */
import type { Attachment, Notification } from "@forumall/shared";
import { deriveDmId } from "@forumall/shared";
import { A, useNavigate, useParams } from "@solidjs/router";
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
import { fetchDmConversations, fetchDmReplies } from "../../lib/dm-api.ts";
import { DmSentStore } from "../../lib/dm-store.ts";
import { clientForHost, domainOf, isLocalActor } from "../../lib/federation.ts";
import { keyStore } from "../../lib/key-store.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import { clearActiveThread, setActiveThread } from "../../stores/active-thread.ts";
import {
  type DmConversationSummary,
  type DmMessage,
  dmConversations,
  dmReactionsFor,
  dmThread,
  dmTypingFor,
  upsertConversation,
  upsertDmMessage,
} from "../../stores/dms.ts";
import {
  markReadLocal,
  markSeenLocal,
  notificationsFor,
  unseenCountFor,
} from "../../stores/notifications.ts";
import { subscribePresence } from "../../stores/presence-controller.ts";
import { displayNameFor, warmProfile, warmProfiles } from "../../stores/profiles.ts";
import { markRead, seqFromCursor, unreadCountFor } from "../../stores/read-markers.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { AttachmentView } from "../shared/AttachmentView.tsx";
import { ReactionBar, ReactionPicker } from "../shared/Reactions.tsx";
import { ReplyQuote } from "../shared/ReplyQuote.tsx";
import { UnreadBadge } from "../shared/UnreadBadge.tsx";
import { Avatar } from "../social/Avatar.tsx";
import { PresenceDot } from "../social/PresenceDot.tsx";
import {
  type ConversationHandle,
  DM_TYPING_IDLE_MS,
  DM_TYPING_THROTTLE_MS,
  deleteDm,
  dmTypingStart,
  dmTypingStop,
  editDm,
  openConversation,
  retrySendDm,
  sendDm,
  toggleDmReaction,
} from "./dm-controller.ts";

/**
 * Inbox tabs. DMs, Mentions and Thread-replies are all wired: Mentions/Threads
 * are backed by the provider-local inbound notifications feed
 * (`/api/me/notifications` + the `notification.created` WS event), surfaced via
 * the notifications store.
 */
type InboxTab = "all" | "dms" | "mentions" | "threads";
const INBOX_TABS: [InboxTab, string, IconName][] = [
  ["all", "All", "inbox"],
  ["dms", "DMs", "at"],
  ["mentions", "Mentions", "bell"],
  ["threads", "Threads", "reply"],
];

/** Empty-state card for an inbox tab whose backing feed has no items yet. */
const InboxPlaceholder: Component<{ testid: string; title: string; detail: string }> = (props) => (
  <div class="px-3 py-6 text-center" data-testid={props.testid}>
    <div class="eyebrow mb-1">{props.title}</div>
    <p class="text-xs text-faint">{props.detail}</p>
  </div>
);

/** One notification row: author avatar/name, a label, time, link to the source. */
const NotificationRow: Component<{ n: Notification }> = (props) => {
  const navigate = useNavigate();
  const label = () =>
    props.n.type === "mention"
      ? "mentioned you"
      : props.n.type === "message"
        ? "posted a message"
        : "replied to you";
  const goToSource = () => {
    // Best-effort: deep-link to the channel's group (channel selection is
    // internal store state, so we land the user on the space). Mark the
    // notification READ on click-through (read implies seen).
    markReadLocal([props.n.id]);
    navigate(`/groups/${props.n.groupId}`);
  };
  return (
    <button
      type="button"
      onClick={goToSource}
      class="flex w-full gap-[11px] rounded-md border-[1.5px] border-transparent p-[11px] text-left transition-colors hover:bg-surface-2"
      classList={{ "opacity-60": !!props.n.readAt }}
      data-testid="notification-row"
      data-notification-id={props.n.id}
      data-notification-type={props.n.type}
    >
      <span class="fa-ava fa-ava--sm" classList={{ "fa-ava__fed": isRemoteActor(props.n.author) }}>
        <Avatar
          actor={props.n.author}
          initials={displayNameFor(props.n.author).slice(0, 1).toUpperCase()}
        />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate font-body text-[13.5px] font-semibold text-ink">
            {displayNameFor(props.n.author)}
          </span>
          <span class="inline-flex items-center gap-1 font-mono text-[10px] text-faint">
            <Icon name={props.n.type === "reply" ? "reply" : "bell"} size={10} />
            {formatTime(props.n.createdAt)}
          </span>
        </span>
        <span class="mt-0.5 block truncate text-xs text-faint">{label()}</span>
      </span>
    </button>
  );
};

/**
 * The list body for a notification tab. Shows the items when present (else the
 * empty placeholder), and marks every loaded notification of this type SEEN when
 * the tab is mounted/viewed (seen = appeared in the list; read happens on
 * click-through).
 */
const NotificationList: Component<{
  type: "mention" | "reply";
  testid: string;
  title: string;
  detail: string;
}> = (props) => {
  const items = createMemo(() => notificationsFor(props.type));
  // Mark unseen notifications of this type SEEN when the tab is viewed.
  createEffect(() => {
    const unseen = items()
      .filter((n) => !n.seenAt)
      .map((n) => n.id);
    if (unseen.length > 0) markSeenLocal(unseen);
  });
  return (
    <Show
      when={items().length > 0}
      fallback={
        <InboxPlaceholder testid={props.testid} title={props.title} detail={props.detail} />
      }
    >
      <ul
        class="flex flex-col gap-0.5"
        data-testid={`inbox-${props.type === "mention" ? "mentions" : "replies"}-list`}
      >
        <For each={items()}>{(n) => <NotificationRow n={n} />}</For>
      </ul>
    </Show>
  );
};

/** The current user's local sent-store, recreated when the actor changes. */
function useSentStore(): () => DmSentStore | null {
  return createMemo(() => (session.actor ? new DmSentStore(session.actor) : null));
}

/**
 * Load + merge the conversation list: the server's inbox-reconstructed
 * conversations PLUS the caller's locally-known (only-sent) ones. Folds both
 * into the reactive DM store so the list re-renders as live events arrive.
 */
async function loadConversations(me: string, sentStore: DmSentStore): Promise<void> {
  const client = sessionClient();
  if (!client) return;
  // Server side: conversations reconstructed from the caller's inbox.
  const server = await fetchDmConversations(client).catch(() => []);
  for (const conv of server) {
    const counterparty = conv.participants.find((p) => p !== me) ?? conv.participants[0] ?? "";
    upsertConversation({
      dmId: conv.id,
      counterparty,
      lastMessageText: conv.lastMessage?.content?.text ?? "",
      updatedAt: conv.updatedAt,
    });
    if (counterparty) sentStore.rememberCounterparty(conv.id, counterparty);
  }
  // Local side: conversations the caller has only SENT to (no inbox row yet).
  for (const dmId of sentStore.knownDmIds()) {
    const counterparty = sentStore.counterpartyFor(dmId);
    if (!counterparty) continue;
    const sent = sentStore.list(dmId);
    const last = sent[sent.length - 1];
    upsertConversation({
      dmId,
      counterparty,
      ...(last ? { lastMessageText: last.content.text ?? "", updatedAt: last.createdAt } : {}),
    });
  }
}

/**
 * Resolve the client a DM to `counterparty` is delivered through (§7.4): the home
 * client for a same-provider recipient, or a per-host client targeting the
 * recipient's domain for a CROSS-PROVIDER DM (signed by the home key; the
 * recipient's provider resolves it via §4.6). Returns `null` if the session has
 * no signing identity (the caller falls back to the home client).
 */
async function resolveDeliveryClient(counterparty: string): Promise<OfscpClient | null> {
  const home = session.host;
  const actor = session.actor;
  const keyId = session.keyId;
  if (!home || !actor || !keyId) return null;
  if (isLocalActor(counterparty, home)) return null; // same provider → home client
  const targetHost = domainOf(counterparty);
  if (!targetHost) return null;
  const privateKey = await keyStore.getKey(keyId);
  if (!privateKey) return null;
  return clientForHost(targetHost, { actor, keyId, privateKey });
}

export const DmsPage: Component = () => {
  const params = useParams<{ dmId?: string }>();
  const navigate = useNavigate();
  const sentStore = useSentStore();
  const [showNew, setShowNew] = createSignal(false);

  // Initial + on-actor-change conversation load into the store.
  const [, { refetch }] = createResource(
    () => session.actor,
    async (me) => {
      const store = sentStore();
      if (me && store) await loadConversations(me, store);
      return true;
    },
  );

  const conversations = createMemo(dmConversations);
  const selected = () => params.dmId;
  const [tab, setTab] = createSignal<InboxTab>("all");

  // Subscribe to live presence for every DM counterparty while the screen is
  // mounted; re-run when the list changes (ref-counted controller de-dupes).
  let disposeSub: (() => void) | null = null;
  createMemo(() => {
    const actors = conversations().map((c) => c.counterparty);
    warmProfiles(actors);
    disposeSub?.();
    disposeSub = subscribePresence(sessionWs(), actors, session.actor);
  });
  onCleanup(() => disposeSub?.());

  return (
    <div class="flex min-h-0 flex-1" data-testid="dms-page">
      {/* Inbox rail: DMs · Mentions · Thread-replies. Mobile master-detail: the
          rail and the thread swap; on < md only one shows at a time. */}
      <aside
        class="w-full shrink-0 flex-col border-r border-border bg-surface md:flex md:w-[300px]"
        classList={{ flex: !selected(), hidden: !!selected() }}
      >
        <div class="flex items-center justify-between px-4 pt-4 pb-2">
          <h1 class="font-display text-base font-bold tracking-tight">Inbox</h1>
          <Show when={tab() === "all" || tab() === "dms"}>
            <button
              type="button"
              class="btn-accent h-7 w-7 p-0 text-base"
              onClick={() => setShowNew(true)}
              aria-label="New direct message"
              data-testid="open-new-dm"
            >
              +
            </button>
          </Show>
        </div>

        <div class="flex flex-wrap gap-1.5 px-3 pb-3" data-testid="inbox-tabs">
          <For each={INBOX_TABS}>
            {([id, label, icon]) => (
              <button
                type="button"
                data-testid={`inbox-tab-${id}`}
                aria-pressed={tab() === id}
                onClick={() => setTab(id)}
                class="inline-flex items-center gap-1.5 rounded-md border-[1.5px] border-border-strong px-2.5 py-1 font-mono text-[12px] transition-transform hover:-translate-y-px"
                classList={{
                  "bg-accent text-accent-ink": tab() === id,
                  "bg-surface text-ink": tab() !== id,
                }}
              >
                <Icon name={icon} size={12} />
                {label}
                <Show when={id === "mentions" && unseenCountFor("mention") > 0}>
                  <UnreadBadge count={unseenCountFor("mention")} variant="inline" />
                </Show>
                <Show when={id === "threads" && unseenCountFor("reply") > 0}>
                  <UnreadBadge count={unseenCountFor("reply")} variant="inline" />
                </Show>
              </button>
            )}
          </For>
        </div>

        <div class="min-h-0 flex-1 overflow-auto px-2 pb-3">
          <Switch>
            <Match when={tab() === "all" || tab() === "dms"}>
              <Show
                when={conversations().length > 0}
                fallback={
                  <p class="px-2 text-sm text-muted" data-testid="dms-empty">
                    No conversations yet. Start one with the + button.
                  </p>
                }
              >
                <ul class="flex flex-col gap-0.5" data-testid="dm-conversations">
                  <For each={conversations()}>
                    {(conv) => <ConversationRow conv={conv} active={selected() === conv.dmId} />}
                  </For>
                </ul>
              </Show>
            </Match>
            <Match when={tab() === "mentions"}>
              <NotificationList
                type="mention"
                testid="inbox-mentions-empty"
                title="Mentions"
                detail="When someone @-mentions you, it'll show up here."
              />
            </Match>
            <Match when={tab() === "threads"}>
              <NotificationList
                type="reply"
                testid="inbox-replies-empty"
                title="Thread-replies"
                detail="Replies to your messages and threads you follow will collect here."
              />
            </Match>
          </Switch>
        </div>
        <TrustNotice />
      </aside>

      {/* Thread / empty pane */}
      <Show
        when={selected()}
        fallback={
          <div class="hidden flex-1 items-center justify-center text-sm text-muted md:flex">
            <p data-testid="dm-no-selection">Select or start a conversation.</p>
          </div>
        }
      >
        {(dmId) => <ThreadView dmId={dmId()} sentStore={sentStore} onSent={() => void refetch()} />}
      </Show>

      <Show when={showNew()}>
        <NewDmModal
          onClose={() => setShowNew(false)}
          onStart={(counterparty) => {
            const me = session.actor;
            if (!me) return;
            const dmId = deriveDmId(me, counterparty);
            const store = sentStore();
            if (store) {
              store.rememberCounterparty(dmId, counterparty);
              upsertConversation({ dmId, counterparty });
            }
            setShowNew(false);
            navigate(`/dms/${dmId}`);
          }}
        />
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Conversation list row
// ---------------------------------------------------------------------------

const ConversationRow: Component<{ conv: DmConversationSummary; active: boolean }> = (props) => (
  <A
    href={`/dms/${props.conv.dmId}`}
    class="flex gap-[11px] rounded-md border-[1.5px] p-[11px] transition-colors"
    classList={{
      "border-accent bg-accent-soft": props.active,
      "border-transparent hover:bg-surface-2": !props.active,
    }}
    data-testid="dm-conversation"
    data-dm-id={props.conv.dmId}
    data-counterparty={props.conv.counterparty}
  >
    <span class="fa-ava" classList={{ "fa-ava__fed": isRemoteActor(props.conv.counterparty) }}>
      <Avatar
        actor={props.conv.counterparty}
        initials={displayNameFor(props.conv.counterparty).slice(0, 1).toUpperCase()}
      />
    </span>
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5" data-testid="dm-conv-name">
        <PresenceDot actor={props.conv.counterparty} />
        <span class="min-w-0 flex-1 truncate font-body text-[13.5px] font-semibold text-ink">
          {displayNameFor(props.conv.counterparty)}
        </span>
        <span class="inline-flex items-center gap-1 font-mono text-[10px] text-faint">
          <Icon name="at" size={10} />
          direct
        </span>
        <Show when={!props.active}>
          <UnreadBadge count={unreadCountFor(props.conv.dmId)} variant="inline" />
        </Show>
      </span>
      <Show when={props.conv.lastMessageText}>
        <span class="mt-0.5 block truncate text-xs text-faint" data-testid="dm-conv-last">
          {props.conv.lastMessageText}
        </span>
      </Show>
    </span>
  </A>
);

// ---------------------------------------------------------------------------
// Thread view
// ---------------------------------------------------------------------------

const ThreadView: Component<{
  dmId: string;
  sentStore: () => DmSentStore | null;
  onSent: () => void;
}> = (props) => {
  const [handle, setHandle] = createSignal<ConversationHandle | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [replyTarget, setReplyTarget] = createSignal<DmMessage | null>(null);

  // Reset any reply target when switching conversations.
  createEffect(
    on(
      () => props.dmId,
      () => setReplyTarget(null),
    ),
  );

  const counterparty = createMemo(() => {
    const me = session.actor ?? "";
    const store = props.sentStore();
    // Prefer the store-known counterparty (covers only-sent threads); else derive
    // from the loaded conversation summary.
    const fromStore = store?.counterpartyFor(props.dmId) ?? null;
    if (fromStore) return fromStore;
    const conv = dmConversations().find((c) => c.dmId === props.dmId);
    if (conv) return conv.counterparty;
    void me;
    return "";
  });

  // (Re)open the conversation whenever the dmId changes.
  createEffect(
    on(
      () => props.dmId,
      (dmId) => {
        const client = sessionClient();
        const ws = sessionWs();
        const store = props.sentStore();
        const me = session.actor;
        setError(null);
        handle()?.close();
        setHandle(null);
        if (!client || !ws || !store || !me) return;
        const other = counterparty();
        if (!other) {
          setError("Unknown participant for this conversation.");
          return;
        }
        let cancelled = false;
        void openConversation({ client, ws, dmId, me, counterparty: other, sentStore: store })
          .then((h) => {
            if (cancelled) h.close();
            else setHandle(h);
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        onCleanup(() => {
          cancelled = true;
        });
      },
    ),
  );

  onCleanup(() => handle()?.close());

  // Track the open DM as the global "active thread" (notify-fx sound suppression:
  // an incoming DM in the thread you're watching while focused doesn't chime).
  createEffect(
    on(
      () => props.dmId,
      (dmId) => setActiveThread("dm", dmId),
    ),
  );
  onCleanup(() => clearActiveThread());

  // Warm the display-name cache for the counterparty + every message author in
  // this thread (covers the remote sender on a federated DM).
  createEffect(() => {
    warmProfile(counterparty());
    warmProfiles(dmThread(props.dmId).map((m) => m.author));
  });

  const messages = createMemo(() => dmThread(props.dmId));
  const typingActors = createMemo(() => dmTypingFor(props.dmId).filter((u) => u !== session.actor));

  // Auto-mark-read: while a DM thread is open, advance its read marker to the
  // newest decodable seq (the DM view always follows the bottom, so an open
  // thread is effectively "pinned"). Excludes the caller's own messages from
  // unread server-side. Re-fires as new messages arrive while the thread is open.
  const newestDmSeq = createMemo(() => {
    let max = 0;
    for (const m of messages()) {
      const s = seqFromCursor(m.cursor);
      if (s != null && s > max) max = s;
    }
    return max;
  });
  createEffect(
    on(
      () => [props.dmId, newestDmSeq()] as const,
      () => {
        const seq = newestDmSeq();
        if (seq > 0) markRead(props.dmId, seq);
      },
    ),
  );

  // Index messages by id so a reply-quote can resolve its parent's snippet.
  const byId = createMemo(() => {
    const map = new Map<string, DmMessage>();
    for (const m of messages()) map.set(m.id, m);
    return map;
  });

  let scrollEl: HTMLDivElement | undefined;
  const scrollToBottom = (): void => {
    queueMicrotask(() => {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  };
  createEffect(on(() => messages().length, scrollToBottom));

  // Jump to a parent message when its reply-quote is clicked: scroll its row into
  // view + flash a transient highlight (no-op if it's outside the loaded window).
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
    <div
      class="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="dm-thread"
      data-dm-id={props.dmId}
    >
      <header class="flex flex-col gap-2 border-b border-border px-6 py-3">
        <div class="flex items-center gap-2">
          <A
            href="/dms"
            class="-ml-1 grid h-8 w-8 shrink-0 place-items-center rounded-sm text-muted hover:(bg-surface-2 text-ink) md:hidden"
            aria-label="Back to inbox"
            data-testid="mobile-back-to-inbox"
          >
            <Icon name="chevLeft" size={18} />
          </A>
          <span
            class="fa-ava fa-ava--sm"
            classList={{ "fa-ava__fed": isRemoteActor(counterparty()) }}
          >
            <Avatar
              actor={counterparty()}
              initials={displayNameFor(counterparty()).slice(0, 1).toUpperCase()}
            />
          </span>
          <h2
            class="font-display text-base font-semibold tracking-tight text-ink"
            data-testid="dm-thread-name"
          >
            {counterparty() ? displayNameFor(counterparty()) : props.dmId}
          </h2>
          <Show when={counterparty() && isRemoteActor(counterparty())}>
            <span class="fa-handle text-accent">@{domainOf(counterparty())}</span>
            <span class="fa-tag">
              <Icon name="lock" size={11} />
              encrypted
            </span>
          </Show>
          <Show when={counterparty()}>
            <PresenceDot actor={counterparty()} showStatus />
          </Show>
          <Show when={counterparty()}>
            <div class="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                class="grid h-[30px] w-[30px] place-items-center rounded-sm text-muted hover:(bg-surface-2 text-ink)"
                title="Voice call"
                aria-label="Voice call"
                tabindex={-1}
              >
                <Icon name="speaker" size={16} />
              </button>
              <button
                type="button"
                class="grid h-[30px] w-[30px] place-items-center rounded-sm text-muted hover:(bg-surface-2 text-ink)"
                title="Video call"
                aria-label="Video call"
                tabindex={-1}
              >
                <Icon name="video" size={16} />
              </button>
            </div>
          </Show>
        </div>
        <Show when={counterparty() && isRemoteActor(counterparty())}>
          <div
            class="flex items-center gap-[9px] rounded-md border-[1.5px] border-dashed border-accent bg-accent-soft px-3 py-[9px] text-[11px] font-mono text-accent"
            data-testid="dm-federated-banner"
          >
            <Icon name="globe" size={15} />
            This person is on another instance — messages cross the network.
          </div>
        </Show>
      </header>

      <div
        ref={scrollEl}
        class="min-h-0 flex-1 overflow-auto px-6 py-4"
        data-testid="dm-message-list"
      >
        <Show when={error()}>
          <p class="text-sm text-danger" data-testid="dm-error">
            {error()}
          </p>
        </Show>
        <Show
          when={messages().length > 0}
          fallback={
            <p class="text-sm text-muted" data-testid="dm-empty-thread">
              No messages yet. Say hello.
            </p>
          }
        >
          <ul class="flex flex-col gap-3">
            <For each={messages()}>
              {(msg) => (
                <DmMessageRow
                  dmId={props.dmId}
                  message={msg}
                  counterparty={counterparty()}
                  sentStore={props.sentStore}
                  byId={byId}
                  highlightId={highlightId}
                  onReply={setReplyTarget}
                  onJumpTo={scrollToMessage}
                />
              )}
            </For>
          </ul>
        </Show>
      </div>

      <DmTypingLine actors={typingActors()} />

      <DmComposer
        dmId={props.dmId}
        counterparty={counterparty()}
        sentStore={props.sentStore}
        replyTarget={replyTarget}
        onClearReply={() => setReplyTarget(null)}
        onSent={props.onSent}
      />
    </div>
  );
};

const DmMessageRow: Component<{
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
    void toggleDmReaction({
      client,
      dmId: props.dmId,
      messageId: m().id,
      me,
      key,
      unicode,
      has: myReactionKeys().has(key),
    }).catch((err) =>
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
    void editDm({ client, dmId: props.dmId, message: m(), me, text, sentStore: store })
      .then(() => setEditing(false))
      .catch((err) =>
        setEditError(err instanceof Error ? err.message : "Could not edit this message."),
      );
  };
  const doDelete = (): void => {
    const client = sessionClient();
    const store = props.sentStore();
    const me = session.actor;
    if (!client || !store || !me) return;
    if (!confirm("Delete this message?")) return;
    setActionError(null);
    void deleteDm({ client, dmId: props.dmId, message: m(), me, sentStore: store }).catch((err) =>
      setActionError(err instanceof Error ? err.message : "Could not delete this message."),
    );
  };

  const retry = (): void => {
    const client = sessionClient();
    const store = props.sentStore();
    const me = session.actor;
    if (!client || !store || !me || !m().clientMessageId) return;
    const counterparty = props.counterparty;
    void resolveDeliveryClient(counterparty).then((deliveryClient) =>
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
        clientMessageId: m().clientMessageId as string,
      }),
    );
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
            <Avatar
              actor={m().author}
              initials={displayNameFor(m().author).slice(0, 1).toUpperCase()}
            />
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
              <div class="flex w-full flex-col gap-1">
                <textarea
                  class="input min-h-16 resize-y"
                  data-testid="dm-edit-input"
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
                    data-testid="dm-save-edit"
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
                  <p class="text-xs text-danger" data-testid="dm-edit-error">
                    {editError()}
                  </p>
                </Show>
              </div>
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
            <div class="flex flex-wrap gap-2" data-testid="dm-attachments">
              <For each={m().attachments ?? []}>{(att) => <AttachmentView attachment={att} />}</For>
            </div>
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
                class="rounded px-2 py-1 text-xs text-faint hover:(bg-surface-2 text-ink) md:px-1.5 md:py-0.5"
                data-testid="dm-reply-button"
                onClick={() => props.onReply(m())}
              >
                Reply
              </button>
              <ReactionPicker onPick={toggleReaction} />
              <Show when={loadedReplies().length > 0}>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-xs text-faint hover:(bg-surface-2 text-accent) md:px-1.5 md:py-0.5"
                  data-testid="dm-view-replies"
                  onClick={viewReplies}
                >
                  {loadedReplies().length} replies
                </button>
              </Show>
              <Show when={mine()}>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-xs text-faint hover:(bg-surface-2 text-ink) md:px-1.5 md:py-0.5"
                  data-testid="dm-edit-message"
                  onClick={startEdit}
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-xs text-faint hover:(bg-surface-2 text-danger) md:px-1.5 md:py-0.5"
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

          <Show when={m().pending || m().failed}>
            <div class="flex items-center gap-2">
              <Show when={m().pending}>
                <span class="text-[10px] text-accent" data-testid="dm-message-pending">
                  sending…
                </span>
              </Show>
              <Show when={m().failed}>
                <button
                  type="button"
                  class="text-[10px] text-danger underline"
                  data-testid="dm-message-retry"
                  onClick={retry}
                >
                  failed — retry
                </button>
              </Show>
            </div>
          </Show>

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
 * stores no other kind), so this renders content as plain text — the same way
 * channel chat renders a `message`/`memo`. (Markdown rendering is reserved for
 * `article`-type messages, which DMs never carry; kept as a single content
 * renderer so the surfaces stay consistent.)
 */
const DmMessageBody: Component<{ message: DmMessage }> = (props) => (
  <p class="whitespace-pre-wrap break-words text-sm leading-[1.45]" data-testid="dm-message-text">
    {props.message.content.text ?? ""}
  </p>
);

/** Typing indicator for the counterparty (mirrors the channel typing line). */
const DmTypingLine: Component<{ actors: string[] }> = (props) => (
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

const DmComposer: Component<{
  dmId: string;
  counterparty: string;
  sentStore: () => DmSentStore | null;
  replyTarget: Accessor<DmMessage | null>;
  onClearReply: () => void;
  onSent: () => void;
}> = (props) => {
  const [text, setText] = createSignal("");
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = createSignal<Attachment[]>([]);
  const [uploading, setUploading] = createSignal(false);

  let lastTypingStart = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let fileInput: HTMLInputElement | undefined;

  const stopTyping = (): void => {
    const ws = sessionWs();
    if (ws) dmTypingStop(ws, props.dmId);
    lastTypingStart = 0;
    if (idleTimer) clearTimeout(idleTimer);
  };

  const onType = (value: string): void => {
    setText(value);
    const ws = sessionWs();
    if (!ws) return;
    const now = Date.now();
    if (now - lastTypingStart > DM_TYPING_THROTTLE_MS) {
      dmTypingStart(ws, props.dmId);
      lastTypingStart = now;
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stopTyping, DM_TYPING_IDLE_MS);
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

  const doSend = (): void => {
    const client = sessionClient();
    const store = props.sentStore();
    const me = session.actor;
    const body = text().trim();
    const atts = pendingAttachments();
    if (!client || !store || !me || !props.counterparty) return;
    if (body.length === 0 && atts.length === 0) return;
    setSendError(null);
    setText("");
    setPendingAttachments([]);
    const target = props.replyTarget();
    props.onClearReply();
    stopTyping();
    const counterparty = props.counterparty;
    void resolveDeliveryClient(counterparty)
      .then((deliveryClient) =>
        sendDm({
          client,
          ...(deliveryClient ? { deliveryClient } : {}),
          dmId: props.dmId,
          me,
          counterparty,
          text: body,
          ...(atts.length > 0 ? { attachments: atts } : {}),
          ...(target ? { reference: { type: "reply", id: target.id } } : {}),
          sentStore: store,
        }),
      )
      .then(() => props.onSent())
      .catch((err) => {
        setSendError(err instanceof Error ? err.message : "Could not send the message.");
      });
  };

  onCleanup(() => {
    if (idleTimer) clearTimeout(idleTimer);
  });

  return (
    <div class="border-t border-border px-6 py-3" data-testid="dm-composer">
      {/* Reply context pill */}
      <Show when={props.replyTarget()}>
        {(t) => (
          <div
            class="mb-2 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-xs"
            data-testid="dm-composer-reply-pill"
          >
            <span class="truncate text-muted">
              Replying to <span class="text-ink">{displayNameFor(t().author)}</span>
            </span>
            <button
              type="button"
              class="ml-auto text-faint hover:text-danger"
              aria-label="Cancel reply"
              data-testid="dm-cancel-reply"
              onClick={() => props.onClearReply()}
            >
              ✕
            </button>
          </div>
        )}
      </Show>

      <Show when={pendingAttachments().length > 0}>
        <div class="mb-2 flex flex-wrap gap-2" data-testid="dm-composer-attachments">
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

      <div class="flex items-end gap-2.5 rounded-md border-[1.5px] border-border-strong bg-surface px-3 py-2 focus-within:(outline outline-2 outline-accent outline-offset-1)">
        <button
          type="button"
          class="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm text-faint transition-colors hover:text-ink disabled:opacity-50"
          data-testid="dm-attach-button"
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
          data-testid="dm-file-input"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void onPickFile(file);
          }}
        />
        <textarea
          class="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          rows={1}
          data-testid="dm-composer-input"
          placeholder={`Message ${props.counterparty ? displayNameFor(props.counterparty) : "…"}…`}
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
          class="btn-accent shrink-0 px-4 py-2 text-xs"
          data-testid="dm-send-button"
          onClick={doSend}
        >
          <Icon name="send" size={14} />
          Send
        </button>
      </div>
      <Show when={sendError()}>
        <p class="mt-1 text-xs text-danger" data-testid="dm-composer-error">
          {sendError()}
        </p>
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------
// New-DM modal
// ---------------------------------------------------------------------------

const NewDmModal: Component<{ onClose: () => void; onStart: (counterparty: string) => void }> = (
  props,
) => {
  const [recipient, setRecipient] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  let inputEl: HTMLInputElement | undefined;
  onMount(() => inputEl?.focus());

  const submit = (): void => {
    const value = recipient().trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(value)) {
      setError("Enter a recipient as handle@domain.");
      return;
    }
    if (value === session.actor) {
      setError("You can't DM yourself.");
      return;
    }
    props.onStart(value);
  };

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      data-testid="new-dm-modal"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
      }}
    >
      <div class="card w-full max-w-sm">
        <h2 class="mb-1 text-sm font-semibold tracking-tight">New direct message</h2>
        <p class="mb-4 text-xs text-muted">Enter a recipient's actor to start a conversation.</p>
        <label class="mb-1 block text-xs text-muted" for="new-dm-recipient">
          Recipient
        </label>
        <input
          ref={inputEl}
          id="new-dm-recipient"
          class="input"
          data-testid="new-dm-recipient"
          placeholder="handle@domain"
          value={recipient()}
          onInput={(e) => {
            setRecipient(e.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") props.onClose();
          }}
        />
        <Show when={error()}>
          <p class="mt-1 text-xs text-danger" data-testid="new-dm-error">
            {error()}
          </p>
        </Show>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="btn-ghost px-3 py-1.5 text-xs" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn-accent px-3 py-1.5 text-xs"
            data-testid="new-dm-start"
            onClick={submit}
          >
            Start chat
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Trust-boundary notice (§8.3 confidentiality)
// ---------------------------------------------------------------------------

const TrustNotice: Component = () => (
  <div
    class="mx-2 mb-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11px] leading-snug text-faint"
    data-testid="dm-trust-notice"
  >
    <span class="text-muted">🔓 Not end-to-end encrypted.</span> Direct messages are readable by the
    recipient's provider and stored in their inbox.
  </div>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whether `actor` lives on a different provider than the signed-in user. */
function isRemoteActor(actor: string): boolean {
  const home = session.host;
  if (!home || !actor) return false;
  return !isLocalActor(actor, home);
}

/** Short HH:MM time for a message timestamp; empty when absent/unparseable. */
function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Full localized date+time for hover precision; empty when absent/unparseable. */
function formatFullTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}
