/**
 * DiscoverPage (P8, spec §11.2) — browse discoverable channels.
 *
 * Consumes `GET /api/discover`, a paged list of POINTERS to `discoverable`-tier
 * channels (channel / group / provider + an OPTIONAL non-authoritative sample).
 * The feature is OPTIONAL: when the provider has it disabled the endpoint 404s —
 * surfaced here as a graceful "discovery not offered by this provider" state
 * (never an error). When available, each pointer can be opened (jump to its group)
 * and FOLLOWED straight from the browse list. Items are pointers — the sample is a
 * preview only; real content is read from the source once followed/opened.
 */
import type { DiscoverItem } from "@forumall/shared";
import { A } from "@solidjs/router";
import { type Component, For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { addFollow, fetchDiscover } from "../../lib/feed-api.ts";
import { sessionClient } from "../../stores/session.ts";
import { EmptyState } from "../shared/EmptyState.tsx";

interface DiscoverState {
  kind: "feed" | "not-offered";
  items: DiscoverItem[];
  nextCursor: string | null;
}

async function loadDiscover(): Promise<DiscoverState> {
  const client = sessionClient();
  if (!client) throw new Error("not authenticated");
  const res = await fetchDiscover(client);
  if (res.kind === "not-offered") {
    return { kind: "not-offered", items: [], nextCursor: null };
  }
  return { kind: "feed", items: res.items, nextCursor: res.nextCursor };
}

export const DiscoverPage: Component = () => {
  const [data] = createResource(loadDiscover);

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="discover-page">
      <header class="border-b border-border px-8 py-5">
        <h1 class="text-lg font-semibold tracking-tight">Discover</h1>
        <p class="mt-0.5 text-sm text-muted">
          Channels this provider recommends. Follow one to add it to your Home feed.
        </p>
      </header>

      <div class="min-h-0 flex-1 overflow-auto px-8 py-6">
        <Switch>
          <Match when={data.loading}>
            <p class="text-sm text-muted" data-testid="discover-loading">
              Loading discovery feed…
            </p>
          </Match>
          <Match when={data.error}>
            <p class="text-sm text-danger" data-testid="discover-error">
              Could not load the discovery feed.
            </p>
          </Match>
          <Match when={data()?.kind === "not-offered"}>
            <div class="card max-w-xl" data-testid="discover-not-offered">
              <p class="text-sm text-muted">Discovery is not offered by this provider.</p>
              <p class="mt-1 text-xs text-faint">
                Your provider doesn't publish a discovery feed. You can still follow channels you
                have access to from any group.
              </p>
            </div>
          </Match>
          <Match when={(data()?.items.length ?? 0) === 0}>
            <EmptyState testid="discover-empty" message="No discoverable channels yet." />
          </Match>
          <Match when={true}>
            <ul class="mx-auto flex max-w-2xl flex-col gap-3" data-testid="discover-list">
              <For each={data()?.items ?? []}>{(item) => <DiscoverRow item={item} />}</For>
            </ul>
          </Match>
        </Switch>
      </div>
    </div>
  );
};

/** One discoverable channel pointer: source labels, a sample preview, and follow. */
const DiscoverRow: Component<{ item: DiscoverItem }> = (props) => {
  const item = () => props.item;
  const [busy, setBusy] = createSignal(false);
  const [followed, setFollowed] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const doFollow = async (): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      await addFollow(client, {
        channel: item().channel,
        ...(item().groupId ? { groupId: item().groupId } : {}),
      });
      setFollowed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not follow this channel.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      class="rounded-xl border border-border bg-surface p-4"
      data-testid="discover-item"
      data-channel={item().channel}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="text-faint">#</span>
            <span class="truncate font-medium text-ink" data-testid="discover-item-channel">
              {item().channel}
            </span>
            <Show when={item().provider}>
              <span class="badge text-[10px]" data-testid="discover-item-provider">
                {item().provider}
              </span>
            </Show>
          </div>
          <Show when={item().groupId}>
            <p class="mt-0.5 text-xs text-faint" data-testid="discover-item-group">
              group {item().groupId}
            </p>
          </Show>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={item().groupId}>
            <A
              href={`/groups/${item().groupId}`}
              class="btn-ghost px-3 py-1.5 text-xs"
              data-testid="discover-open"
            >
              Open
            </A>
          </Show>
          <button
            type="button"
            class="btn-accent px-3 py-1.5 text-xs"
            data-testid="discover-follow"
            disabled={busy() || followed()}
            onClick={() => void doFollow()}
          >
            {followed() ? "Following" : busy() ? "Following…" : "Follow"}
          </button>
        </div>
      </div>

      {/* Non-authoritative sample preview (read real content from the source). */}
      <Show when={item().sample}>
        {(sample) => (
          <div
            class="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
            data-testid="discover-sample"
          >
            <div class="mb-0.5 text-[10px] uppercase tracking-wide text-faint">Sample</div>
            <p class="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted">
              {sample().content?.text ?? "(no preview)"}
            </p>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <p class="mt-2 text-xs text-danger" data-testid="discover-follow-error">
          {error()}
        </p>
      </Show>
    </li>
  );
};
