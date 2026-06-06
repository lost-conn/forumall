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
  Show,
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
import {
  type DmConversationSummary,
  dmConversations,
  dmThread,
  upsertConversation,
} from "../../stores/dms.ts";
import { subscribePresence } from "../../stores/presence-controller.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { PresenceDot } from "../social/PresenceDot.tsx";
import { type ConversationHandle, openConversation, retrySendDm, sendDm } from "./dm-controller.ts";

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
      {/* Conversation list rail */}
      <aside class="flex w-72 shrink-0 flex-col border-r border-border bg-surface">
        <div class="flex items-center justify-between px-4 py-4">
          <h1 class="text-sm font-semibold tracking-tight">Direct messages</h1>
          <button
            type="button"
            class="grid h-7 w-7 place-items-center rounded-lg bg-accent text-white hover:bg-accent-hi"
            onClick={() => setShowNew(true)}
            aria-label="New direct message"
            data-testid="open-new-dm"
          >
            +
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto px-2 pb-3">
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
    class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors"
    classList={{
      "bg-surface-2 text-ink": props.active,
      "text-muted hover:(bg-surface-2 text-ink)": !props.active,
    }}
    data-testid="dm-conversation"
    data-dm-id={props.conv.dmId}
    data-counterparty={props.conv.counterparty}
  >
    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-cyan text-xs font-bold text-white">
      {displayName(props.conv.counterparty).slice(0, 1).toUpperCase()}
    </span>
    <span class="min-w-0 flex-1">
      <span
        class="flex items-center gap-1.5 truncate font-medium text-ink"
        data-testid="dm-conv-name"
      >
        <PresenceDot actor={props.conv.counterparty} />
        <span class="truncate">{props.conv.counterparty}</span>
      </span>
      <Show when={props.conv.lastMessageText}>
        <span class="block truncate text-xs text-faint" data-testid="dm-conv-last">
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
      <header class="flex items-center gap-2 border-b border-border px-6 py-3">
        <span class="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-accent to-cyan text-xs font-bold text-white">
          {displayName(counterparty()).slice(0, 1).toUpperCase()}
        </span>
        <h2 class="text-sm font-semibold tracking-tight" data-testid="dm-thread-name">
          {counterparty() || props.dmId}
        </h2>
        <Show when={counterparty()}>
          <PresenceDot actor={counterparty()} showStatus />
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
      class="flex flex-col gap-1"
      data-testid="dm-message"
      data-message-id={m().id}
      data-mine={mine() ? "1" : "0"}
      data-pending={m().pending ? "1" : undefined}
    >
      <div class="flex items-baseline gap-2">
        <span class="text-xs font-semibold text-ink" data-testid="dm-message-author">
          {mine() ? "You" : displayName(m().author)}
        </span>
        <span class="text-[10px] text-faint">{formatTime(m().createdAt)}</span>
        <Show when={m().pending}>
          <span class="text-[10px] text-cyan" data-testid="dm-message-pending">
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
                void retrySendDm({
                  client,
                  dmId: props.dmId,
                  me,
                  counterparty: props.counterparty,
                  text: m().content.text ?? "",
                  sentStore: store,
                  clientMessageId: m().clientMessageId as string,
                });
              }
            }}
          >
            failed — retry
          </button>
        </Show>
      </div>
      <p class="text-sm text-ink whitespace-pre-wrap break-words" data-testid="dm-message-text">
        {m().content.text ?? ""}
      </p>
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
    void sendDm({
      client,
      dmId: props.dmId,
      me,
      counterparty: props.counterparty,
      text: body,
      sentStore: store,
    })
      .then(() => props.onSent())
      .catch((err) => {
        setSendError(err instanceof Error ? err.message : "Could not send the message.");
      });
  };

  return (
    <div class="border-t border-border px-6 py-3" data-testid="dm-composer">
      <div class="flex items-end gap-2">
        <textarea
          class="input max-h-40 min-h-10 flex-1 resize-y"
          data-testid="dm-composer-input"
          placeholder={`Message ${props.counterparty || "…"}`}
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
          class="btn-accent shrink-0 px-4 py-2 text-sm"
          data-testid="dm-send-button"
          onClick={doSend}
        >
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

/** Short HH:MM time for a message timestamp; empty when absent/unparseable. */
function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
