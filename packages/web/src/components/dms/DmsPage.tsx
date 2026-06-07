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
import { deriveDmId } from "@forumall/shared";
import { A, useNavigate, useParams } from "@solidjs/router";
import {
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
import { fetchDmConversations } from "../../lib/dm-api.ts";
import { DmSentStore } from "../../lib/dm-store.ts";
import { clientForHost, domainOf, isLocalActor } from "../../lib/federation.ts";
import { keyStore } from "../../lib/key-store.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import {
  type DmConversationSummary,
  dmConversations,
  dmThread,
  upsertConversation,
} from "../../stores/dms.ts";
import { subscribePresence } from "../../stores/presence-controller.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { PresenceDot } from "../social/PresenceDot.tsx";
import { type ConversationHandle, openConversation, retrySendDm, sendDm } from "./dm-controller.ts";

/**
 * Inbox tabs. DMs are fully wired; Mentions and Thread-replies are presented but
 * not yet populated — surfacing them requires a server-side notifications/mentions
 * feed (none exists today; §10 notifications are outbound webhooks only). Tracked
 * as its own backend epic on the Forumall board.
 */
type InboxTab = "all" | "dms" | "mentions" | "threads";
const INBOX_TABS: [InboxTab, string, IconName][] = [
  ["all", "All", "inbox"],
  ["dms", "DMs", "at"],
  ["mentions", "Mentions", "bell"],
  ["threads", "Threads", "reply"],
];

/** Placeholder for an inbox tab whose backing feed isn't built yet. */
const InboxPlaceholder: Component<{ testid: string; title: string; detail: string }> = (props) => (
  <div class="px-3 py-6 text-center" data-testid={props.testid}>
    <div class="eyebrow mb-1">{props.title}</div>
    <p class="text-xs text-faint">{props.detail}</p>
  </div>
);

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
    disposeSub?.();
    disposeSub = subscribePresence(sessionWs(), actors, session.actor);
  });
  onCleanup(() => disposeSub?.());

  return (
    <div class="flex min-h-0 flex-1" data-testid="dms-page">
      {/* Inbox rail: DMs · Mentions · Thread-replies */}
      <aside class="flex w-[300px] shrink-0 flex-col border-r border-border bg-surface">
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
              <InboxPlaceholder
                testid="inbox-mentions-empty"
                title="Mentions"
                detail="When someone @-mentions you, it'll show up here."
              />
            </Match>
            <Match when={tab() === "threads"}>
              <InboxPlaceholder
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
          <div class="flex flex-1 items-center justify-center text-sm text-muted">
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
      {displayName(props.conv.counterparty).slice(0, 1).toUpperCase()}
    </span>
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5" data-testid="dm-conv-name">
        <PresenceDot actor={props.conv.counterparty} />
        <span class="min-w-0 flex-1 truncate font-body text-[13.5px] font-semibold text-ink">
          {displayName(props.conv.counterparty)}
        </span>
        <span class="inline-flex items-center gap-1 font-mono text-[10px] text-faint">
          <Icon name="at" size={10} />
          direct
        </span>
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

  const messages = createMemo(() => dmThread(props.dmId));

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
    <div class="flex min-h-0 flex-1 flex-col" data-testid="dm-thread" data-dm-id={props.dmId}>
      <header class="flex flex-col gap-2 border-b border-border px-6 py-3">
        <div class="flex items-center gap-2">
          <span
            class="fa-ava fa-ava--sm"
            classList={{ "fa-ava__fed": isRemoteActor(counterparty()) }}
          >
            {displayName(counterparty()).slice(0, 1).toUpperCase()}
          </span>
          <h2
            class="font-display text-base font-semibold tracking-tight text-ink"
            data-testid="dm-thread-name"
          >
            {displayName(counterparty()) || props.dmId}
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
                />
              )}
            </For>
          </ul>
        </Show>
      </div>

      <DmComposer
        dmId={props.dmId}
        counterparty={counterparty()}
        sentStore={props.sentStore}
        onSent={props.onSent}
      />
    </div>
  );
};

const DmMessageRow: Component<{
  dmId: string;
  message: ReturnType<typeof dmThread>[number];
  counterparty: string;
  sentStore: () => DmSentStore | null;
}> = (props) => {
  const m = () => props.message;
  const mine = () => m().mine === true || m().author === session.actor;
  return (
    <li
      class="flex items-start gap-[9px]"
      classList={{ "justify-end": mine() }}
      data-testid="dm-message"
      data-message-id={m().id}
      data-mine={mine() ? "1" : "0"}
      data-pending={m().pending ? "1" : undefined}
    >
      <Show when={!mine()}>
        <span class="fa-ava fa-ava--sm" classList={{ "fa-ava__fed": isRemoteActor(m().author) }}>
          {displayName(m().author).slice(0, 1).toUpperCase()}
        </span>
      </Show>
      <div class="flex max-w-[70%] flex-col gap-1" classList={{ "items-end": mine() }}>
        <p
          class="whitespace-pre-wrap break-words rounded-md border-[1.5px] px-[13px] py-[9px] text-sm leading-[1.45]"
          classList={{
            "border-accent bg-accent-soft text-ink": mine(),
            "border-border-strong bg-surface text-ink": !mine(),
          }}
          data-testid="dm-message-text"
        >
          {m().content.text ?? ""}
        </p>
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
                onClick={() => {
                  const client = sessionClient();
                  const store = props.sentStore();
                  const me = session.actor;
                  if (client && store && me && m().clientMessageId) {
                    const counterparty = props.counterparty;
                    void resolveDeliveryClient(counterparty).then((deliveryClient) =>
                      retrySendDm({
                        client,
                        ...(deliveryClient ? { deliveryClient } : {}),
                        dmId: props.dmId,
                        me,
                        counterparty,
                        text: m().content.text ?? "",
                        sentStore: store,
                        clientMessageId: m().clientMessageId as string,
                      }),
                    );
                  }
                }}
              >
                failed — retry
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </li>
  );
};

const DmComposer: Component<{
  dmId: string;
  counterparty: string;
  sentStore: () => DmSentStore | null;
  onSent: () => void;
}> = (props) => {
  const [text, setText] = createSignal("");
  const [sendError, setSendError] = createSignal<string | null>(null);

  const doSend = (): void => {
    const client = sessionClient();
    const store = props.sentStore();
    const me = session.actor;
    const body = text().trim();
    if (!client || !store || !me || body.length === 0 || !props.counterparty) return;
    setSendError(null);
    setText("");
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
          sentStore: store,
        }),
      )
      .then(() => props.onSent())
      .catch((err) => {
        setSendError(err instanceof Error ? err.message : "Could not send the message.");
      });
  };

  return (
    <div class="border-t border-border px-6 py-3" data-testid="dm-composer">
      <div class="flex items-end gap-2.5 rounded-md border-[1.5px] border-border-strong bg-surface px-3 py-2 focus-within:(outline outline-2 outline-accent outline-offset-1)">
        <span class="pb-0.5 text-faint" title="Not end-to-end encrypted">
          <Icon name="lock" size={16} />
        </span>
        <textarea
          class="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          rows={1}
          data-testid="dm-composer-input"
          placeholder={`Message ${displayName(props.counterparty) || "…"}…`}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
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

/** Display the local-part of an actor `handle@host` (full actor as a fallback). */
function displayName(actor: string): string {
  const at = actor.indexOf("@");
  return at > 0 ? actor.slice(0, at) : actor;
}

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
