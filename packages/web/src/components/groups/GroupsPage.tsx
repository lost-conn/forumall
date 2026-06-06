/**
 * Groups screen (P8). A left list of the user's groups + a create button, with
 * the selected group's view filling the rest. Route-driven: `/groups` shows the
 * list with an empty state; `/groups/{id}` selects a group.
 */
import { A, useNavigate, useParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Show, createSignal } from "solid-js";
import { CreateGroupModal } from "./CreateGroupModal.tsx";
import { GroupView } from "./GroupView.tsx";
import { myGroupsQuery } from "./queries.ts";

export const GroupsPage: Component = () => {
  const params = useParams<{ groupId?: string }>();
  const navigate = useNavigate();
  const groups = useQuery(myGroupsQuery);
  const [showCreate, setShowCreate] = createSignal(false);

  const selected = () => params.groupId;

  return (
    <div class="flex min-h-0 flex-1">
      {/* Group list rail */}
      <aside class="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
        <div class="flex items-center justify-between px-4 py-4">
          <h1 class="text-sm font-semibold tracking-tight">Your groups</h1>
          <button
            type="button"
            class="grid h-7 w-7 place-items-center rounded-lg bg-accent text-white hover:bg-accent-hi"
            onClick={() => setShowCreate(true)}
            aria-label="Create group"
            data-testid="open-create-group"
          >
            +
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto px-2 pb-3">
          <Show when={!groups.isLoading} fallback={<p class="px-2 text-sm text-muted">Loading…</p>}>
            <Show
              when={(groups.data ?? []).length > 0}
              fallback={
                <p class="px-2 text-sm text-muted" data-testid="groups-empty">
                  You're not in any groups yet. Create one to get started.
                </p>
              }
            >
              <ul class="flex flex-col gap-0.5" data-testid="my-groups-list">
                <For each={groups.data ?? []}>
                  {(grp) => (
                    <A
                      href={`/groups/${grp.id}`}
                      class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors"
                      classList={{
                        "bg-surface-2 text-ink": selected() === grp.id,
                        "text-muted hover:(bg-surface-2 text-ink)": selected() !== grp.id,
                      }}
                      data-testid="my-group-item"
                      data-group-name={grp.name}
                    >
                      <span class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-accent to-cyan text-xs font-bold text-white">
                        {grp.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span class="truncate">{grp.name}</span>
                    </A>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      </aside>

      {/* Selected group view, or an empty prompt */}
      <Show
        when={selected()}
        fallback={
          <div class="grid flex-1 place-items-center p-8 text-center">
            <div class="max-w-sm">
              <p class="text-sm text-muted">Select a group on the left, or create a new one.</p>
              <button
                type="button"
                class="btn-accent mt-4"
                onClick={() => setShowCreate(true)}
                data-testid="empty-create-group"
              >
                Create a group
              </button>
            </div>
          </div>
        }
      >
        {(id) => <GroupView groupId={id()} />}
      </Show>

      <Show when={showCreate()}>
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          onCreated={(groupId) => {
            setShowCreate(false);
            navigate(`/groups/${groupId}`);
          }}
        />
      </Show>
    </div>
  );
};
