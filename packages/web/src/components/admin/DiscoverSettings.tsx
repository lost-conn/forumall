/**
 * Admin-curated discover settings (Forumall extension, admin-only).
 *
 * Lets the instance admin choose which GROUPS are featured in the discovery feed
 * (§11.2). The feed surfaces only `discoverable`-tier channels whose owning group
 * appears on this allowlist. Two lists:
 *
 *  - "Featured in discover" — the currently-featured groups, each with Remove.
 *  - "Available groups" — candidate groups (those with at least one discoverable
 *    channel that are not yet featured), each with Add.
 *
 * Backed by `GET/PUT/DELETE /api/admin/discover[/{groupId}]`. Gated on
 * `session.isAdmin` by the parent `SettingsShell`; the server enforces it (403)
 * regardless.
 */
import { type Component, For, Show, createResource, createSignal } from "solid-js";
import { sessionClient } from "../../stores/session.ts";

interface GroupSummary {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
}

interface DiscoverAdminResponse {
  featured: GroupSummary[];
  candidates: GroupSummary[];
}

async function loadDiscoverAdmin(): Promise<DiscoverAdminResponse> {
  const client = sessionClient();
  if (!client) throw new Error("not authenticated");
  const res = await client.get<DiscoverAdminResponse>("/api/admin/discover");
  return res.data;
}

export const DiscoverSettings: Component = () => {
  const [data, { refetch }] = createResource(loadDiscoverAdmin);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const feature = async (groupId: string): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setBusyId(groupId);
    setError(null);
    try {
      await client.put(`/api/admin/discover/${encodeURIComponent(groupId)}`);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not feature that group.");
    } finally {
      setBusyId(null);
    }
  };

  const unfeature = async (groupId: string): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setBusyId(groupId);
    setError(null);
    try {
      await client.delete(`/api/admin/discover/${encodeURIComponent(groupId)}`);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that group.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div class="flex flex-col gap-5" data-testid="discover-settings">
      <p class="text-sm text-muted">
        Choose which communities appear in this instance's Discover feed. Only groups you feature
        here are shown — and only their <span class="font-mono text-ink">discoverable</span>{" "}
        channels.
      </p>

      <Show
        when={!data.error}
        fallback={
          <p class="text-sm text-danger" data-testid="discover-settings-error">
            Could not load discover settings.
          </p>
        }
      >
        {/* Featured */}
        <section class="card flex flex-col gap-3">
          <span class="eyebrow">Featured in discover</span>
          <Show
            when={(data()?.featured.length ?? 0) > 0}
            fallback={
              <p class="fa-meta" data-testid="discover-featured-empty">
                No groups featured yet. Add one from the list below.
              </p>
            }
          >
            <ul class="flex flex-col gap-2" data-testid="discover-featured-list">
              <For each={data()?.featured ?? []}>
                {(group) => (
                  <GroupRow
                    group={group}
                    action="remove"
                    busy={busyId() === group.id}
                    onAction={() => void unfeature(group.id)}
                  />
                )}
              </For>
            </ul>
          </Show>
        </section>

        {/* Candidates */}
        <section class="card flex flex-col gap-3">
          <span class="eyebrow">Available groups</span>
          <Show
            when={(data()?.candidates.length ?? 0) > 0}
            fallback={
              <p class="fa-meta" data-testid="discover-candidates-empty">
                No eligible groups. A group must have at least one discoverable channel before it
                can be featured.
              </p>
            }
          >
            <ul class="flex flex-col gap-2" data-testid="discover-candidates-list">
              <For each={data()?.candidates ?? []}>
                {(group) => (
                  <GroupRow
                    group={group}
                    action="add"
                    busy={busyId() === group.id}
                    onAction={() => void feature(group.id)}
                  />
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>

      <Show when={error()}>
        <p class="text-sm text-danger" data-testid="discover-action-error">
          {error()}
        </p>
      </Show>
    </div>
  );
};

/** One group row with an Add or Remove action. */
const GroupRow: Component<{
  group: GroupSummary;
  action: "add" | "remove";
  busy: boolean;
  onAction: () => void;
}> = (props) => {
  return (
    <li
      class="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2"
      data-testid="discover-group-row"
      data-group={props.group.id}
    >
      <span class="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md border-[1.5px] border-border-strong bg-surface-2 text-sm text-faint">
        <Show
          when={props.group.avatar}
          fallback={(props.group.name || "?").slice(0, 1).toUpperCase()}
        >
          <img src={props.group.avatar} alt="" class="h-full w-full object-cover" />
        </Show>
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-ink">{props.group.name}</div>
        <Show when={props.group.description}>
          <p class="truncate text-xs text-faint">{props.group.description}</p>
        </Show>
      </div>
      <Show
        when={props.action === "add"}
        fallback={
          <button
            type="button"
            class="btn-ghost px-3 py-1.5 text-xs hover:(border-danger text-danger)"
            disabled={props.busy}
            onClick={() => props.onAction()}
            data-testid="discover-remove"
          >
            {props.busy ? "Removing…" : "Remove"}
          </button>
        }
      >
        <button
          type="button"
          class="btn-accent px-3 py-1.5 text-xs"
          disabled={props.busy}
          onClick={() => props.onAction()}
          data-testid="discover-add"
        >
          {props.busy ? "Adding…" : "Add"}
        </button>
      </Show>
    </li>
  );
};
