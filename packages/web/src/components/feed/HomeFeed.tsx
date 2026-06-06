/**
 * HomeFeed (P8, spec §7.6) — the headline convenience: ONE feed across channels.
 *
 * Composed entirely client-side from the follow pointers (see
 * `feed-controller.ts`): for each followed channel it reads recent history and
 * subscribes for live updates over that channel's source WS, folding everything
 * into the shared chat store. This view renders the DERIVED merged timeline
 * (`stores/feed.ts#mergedTimeline`) — every followed channel's messages, ordered
 * newest-first and de-duped by id — so a live message, an in-place edit, or a
 * tombstone on ANY followed channel updates here automatically. Each item shows
 * its source channel / group + author, and renders by §5.3 message type (markdown
 * for `article`s, text otherwise, a safe fallback for unknown types).
 */
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
import { renderMarkdown } from "../../lib/markdown.ts";
import { type FeedItem, activeFollows, feed, mergedTimeline } from "../../stores/feed.ts";
import { clearFeed } from "../../stores/feed.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
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

/** One merged-feed item: source channel/group + author + body (typed render). */
const FeedRow: Component<{ item: FeedItem }> = (props) => {
  const item = () => props.item;
  const isDeleted = () => item().deletedAt !== undefined;
  return (
    <li
      class="rounded-xl border border-border bg-surface p-4"
      data-testid="feed-item"
      data-channel-id={item().channelId}
      data-message-id={item().id}
    >
      <div class="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span class="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-muted">
          <span class="text-faint">#</span>
          <span class="text-ink" data-testid="feed-item-channel">
            {item().channelName ?? item().channelId}
          </span>
          <Show when={item().groupName}>
            <span class="text-faint">· {item().groupName}</span>
          </Show>
        </span>
        <span class="font-semibold text-ink" data-testid="feed-item-author">
          {displayName(item().author)}
        </span>
        <span class="text-faint">{formatTime(item().createdAt)}</span>
        <Show when={item().editedAt && !isDeleted()}>
          <span class="text-faint" data-testid="feed-item-edited">
            (edited)
          </span>
        </Show>
      </div>

      <Switch>
        <Match when={isDeleted()}>
          <p class="text-sm italic text-faint" data-testid="feed-item-tombstone">
            message deleted
          </p>
        </Match>
        <Match when={(item().type ?? "message") === "article"}>
          {/* `renderMarkdown` escapes input + allowlists link schemes (sanitized). */}
          <div
            class="prose-chat text-sm text-ink"
            data-testid="feed-item-article"
            innerHTML={renderMarkdown(item().content.text ?? "")}
          />
        </Match>
        <Match when={true}>
          <p class="whitespace-pre-wrap break-words text-sm text-ink" data-testid="feed-item-text">
            {item().content.text ?? ""}
          </p>
        </Match>
      </Switch>
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
