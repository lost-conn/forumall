/**
 * FollowToggle (P8, spec §7.6) — the follow/unfollow control shown on a channel
 * (the chat view header). A follow is a POINTER: this just records/removes which
 * channel the caller follows; the Home feed composes content from the source.
 *
 * Followed state is tracked in a small module-level cache (the set of followed
 * local channel ids), lazily hydrated once per session from `GET /api/me/follows`
 * so every toggle across the app reflects a consistent state without each control
 * re-fetching. Toggling calls `POST /api/me/follows {channel, groupId}` /
 * `DELETE /api/me/follows/{channelRef}` and flips the cache.
 */
import { type Component, Show, createSignal, onMount } from "solid-js";
import { addFollow, fetchFollows, removeFollow } from "../../lib/feed-api.ts";
import { localChannelId } from "../../lib/feed-api.ts";
import { session, sessionClient } from "../../stores/session.ts";

/** Session-scoped cache of followed LOCAL channel ids (hydrated once). */
const followedIds = new Set<string>();
let hydrated = false;
let hydrating: Promise<void> | null = null;

/** Lazily hydrate the followed-id cache from the server (once per session). */
async function ensureHydrated(): Promise<void> {
  if (hydrated) return;
  if (hydrating) return hydrating;
  hydrating = (async () => {
    const client = sessionClient();
    const host = session.host;
    if (!client || !host) return;
    try {
      const follows = await fetchFollows(client);
      for (const f of follows) {
        const id = localChannelId(f.channel, host) ?? f.channel;
        followedIds.add(id);
      }
      hydrated = true;
    } catch {
      /* leave un-hydrated; the toggle still works optimistically */
    }
  })();
  await hydrating;
  hydrating = null;
}

/** Reset the follow cache (logout / session change). */
export function resetFollowCache(): void {
  followedIds.clear();
  hydrated = false;
  hydrating = null;
}

export const FollowToggle: Component<{ channelId: string; groupId: string }> = (props) => {
  const [following, setFollowing] = createSignal(followedIds.has(props.channelId));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Hydrate the shared cache once, then reflect this channel's followed state.
  onMount(() => {
    void ensureHydrated().then(() => setFollowing(followedIds.has(props.channelId)));
  });

  const toggle = async (): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setBusy(true);
    setError(null);
    const wantFollow = !following();
    try {
      if (wantFollow) {
        await addFollow(client, { channel: props.channelId, groupId: props.groupId });
        followedIds.add(props.channelId);
      } else {
        await removeFollow(client, props.channelId);
        followedIds.delete(props.channelId);
      }
      setFollowing(wantFollow);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update follow.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span class="ml-auto flex items-center gap-2">
      <Show when={error()}>
        <span class="text-[10px] text-danger" data-testid="follow-error">
          {error()}
        </span>
      </Show>
      <button
        type="button"
        class="px-2.5 py-1 text-xs"
        classList={{
          "btn-accent": !following(),
          "btn-ghost": following(),
        }}
        data-testid="follow-toggle"
        data-following={following() ? "1" : "0"}
        disabled={busy()}
        onClick={() => void toggle()}
      >
        {busy() ? "…" : following() ? "Following" : "Follow"}
      </button>
    </span>
  );
};
