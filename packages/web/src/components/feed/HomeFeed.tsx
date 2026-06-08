/**
 * HomeFeed (P8, spec §7.6) — the headline convenience: ONE feed across channels.
 *
 * Composed entirely client-side from the follow pointers (see
 * `feed-controller.ts`): for each followed channel it reads recent history and
 * subscribes for live updates over that channel's source WS, folding everything
 * into the shared chat store. This view renders the DERIVED merged timeline
 * (`stores/feed.ts#mergedTimeline`) — every followed channel's messages, ordered
 * newest-first and de-duped by id — so a live message, an in-place edit, or a
 * tombstone on ANY followed channel updates here automatically. Each item is
 * rendered with the **same layout as a channel message** (the shared
 * {@link MessageBody}/{@link AttachmentView} from the chat view) so Home reads
 * identically to a channel, plus a source channel/group badge for context.
 */
import { useNavigate } from "@solidjs/router";
import {
  type Component,
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { reactionsFor } from "../../stores/chat.ts";
import { type FeedItem, activeFollows, feed, mergedTimeline } from "../../stores/feed.ts";
import { clearFeed } from "../../stores/feed.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { AttachmentView, MessageBody } from "../chat/ChatView.tsx";
import { openUserProfile } from "../social/user-profile-store.ts";
import { type FeedHandle, startFeed } from "./feed-controller.ts";

export const HomeFeed: Component = () => {
  const [error, setError] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(true);
  let handle: FeedHandle | null = null;

  onMount(() => {
    const client = sessionClient();
    const ws = sessionWs();
    const host = session.host;
    const actor = session.actor;
    const keyId = session.keyId;
    if (!client || !ws || !host || !actor || !keyId) {
      setStarting(false);
      setError("Not connected to your provider.");
      return;
    }
    void startFeed({ client, homeWs: ws, homeHost: host, actor, keyId })
      .then((h) => {
        handle = h;
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setStarting(false));
  });

  onCleanup(() => {
    handle?.close();
    // The follow registry is session-scoped; reset on leaving Home so a return
    // re-reads it fresh (a logout also clears it via the session teardown).
    clearFeed();
  });

  const items = createMemo<FeedItem[]>(() => mergedTimeline());
  const follows = createMemo(() => activeFollows());

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="home-feed">
      <header class="flex items-center justify-between border-b border-border px-8 py-5">
        <div>
          <h1 class="text-lg font-semibold tracking-tight">Home</h1>
          <p class="mt-0.5 text-sm text-muted">
            One feed across the channels you follow, newest first.
          </p>
        </div>
        <Show when={follows().length > 0}>
          <span class="badge" data-testid="feed-follow-count">
            {follows().length} {follows().length === 1 ? "channel" : "channels"}
          </span>
        </Show>
      </header>

      <div class="min-h-0 flex-1 overflow-auto px-8 py-6">
        <Show when={error()}>
          <p class="mb-4 text-sm text-danger" data-testid="feed-error">
            {error()}
          </p>
        </Show>

        <Switch>
          <Match when={starting() && !feed.loaded}>
            <p class="text-sm text-muted" data-testid="feed-loading">
              Composing your feed…
            </p>
          </Match>
          <Match when={feed.loaded && follows().length === 0}>
            <div class="card max-w-xl" data-testid="feed-empty">
              <p class="text-sm text-muted">
                You're not following any channels yet. Open a channel and tap{" "}
                <span class="text-ink">Follow</span>, or browse{" "}
                <a class="text-accent hover:text-accent-hi" href="/discover">
                  Discover
                </a>{" "}
                to find channels.
              </p>
            </div>
          </Match>
          <Match when={items().length === 0}>
            <p class="text-sm text-muted" data-testid="feed-no-messages">
              No messages in your followed channels yet.
            </p>
          </Match>
          <Match when={true}>
            <ul class="mx-auto flex max-w-2xl flex-col gap-3" data-testid="feed-list">
              <For each={items()}>{(item) => <FeedRow item={item} />}</For>
            </ul>
          </Match>
        </Switch>
      </div>
    </div>
  );
};

/**
 * One merged-feed item, rendered with the same layout as a channel message
 * (avatar + author/time header + typed {@link MessageBody} + attachments +
 * reactions) so Home reads identically to a channel. The only feed addition is
 * the source channel/group badge (it links back to the group); message actions
 * (reply/edit/react) are channel-local and intentionally omitted here.
 */
const FeedRow: Component<{ item: FeedItem }> = (props) => {
  const item = () => props.item;
  const isDeleted = () => item().deletedAt !== undefined;
  const navigate = useNavigate();
  const reactions = () => reactionsFor(item().channelId, item().id);
  const openSource = (): void => {
    const gid = item().groupId;
    if (gid) navigate(`/groups/${gid}`);
  };
  return (
    <li
      class="group/msg flex gap-[11px]"
      data-testid="feed-item"
      data-channel-id={item().channelId}
      data-message-id={item().id}
    >
      <button
        type="button"
        class="fa-ava transition-colors hover:border-accent"
        aria-label={`${displayName(item().author)} profile`}
        onClick={() => openUserProfile(item().author)}
      >
        {displayName(item().author).slice(0, 1).toUpperCase()}
      </button>

      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="fa-msg__name"
            onClick={() => openUserProfile(item().author)}
            data-testid="feed-item-author"
          >
            {displayName(item().author)}
          </button>
          <span class="fa-meta">{formatTime(item().createdAt)}</span>
          <Show when={item().editedAt && !isDeleted()}>
            <span class="fa-meta" data-testid="feed-item-edited">
              (edited)
            </span>
          </Show>
          {/* Source channel/group — feed-specific context; links back to the group. */}
          <button
            type="button"
            class="ml-auto inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-xs text-muted transition-colors hover:text-ink"
            onClick={openSource}
            data-testid="feed-item-channel"
          >
            <span class="text-faint">#</span>
            <span class="text-ink">{item().channelName ?? item().channelId}</span>
            <Show when={item().groupName}>
              <span class="text-faint">· {item().groupName}</span>
            </Show>
          </button>
        </div>

        <Switch>
          <Match when={isDeleted()}>
            <p class="text-sm italic text-faint" data-testid="feed-item-tombstone">
              message deleted
            </p>
          </Match>
          <Match when={true}>
            <MessageBody message={item()} onOpenArticle={openSource} />
          </Match>
        </Switch>

        <Show when={!isDeleted() && (item().attachments?.length ?? 0) > 0}>
          <div class="flex flex-wrap gap-2">
            <For each={item().attachments ?? []}>
              {(att) => <AttachmentView attachment={att} />}
            </For>
          </div>
        </Show>

        <Show when={reactions().length > 0}>
          <div class="fa-rx">
            <For each={reactions()}>
              {(g) => (
                <span
                  class="fa-rx__chip"
                  classList={{
                    "fa-rx__chip--on": session.actor != null && g.authors.includes(session.actor),
                  }}
                >
                  <span>{g.unicode ?? g.key}</span>
                  <span>{g.authors.length}</span>
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
    </li>
  );
};

/** Display the local-part of an actor `handle@host` (full actor as fallback). */
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
