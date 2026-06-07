/**
 * Groups screen (P8). Route-driven: `/groups/{id}` renders the group's "space"
 * layout ({@link GroupView} — channel-list column + main chat). `/groups` with no
 * id is the index: pick an existing space or create one. (The persistent space
 * rail also lists the user's groups as avatars.)
 */
import { A, useNavigate, useParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Show, createSignal } from "solid-js";
import { Icon } from "../Icon.tsx";
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
      <Show when={selected()} fallback={null}>
        {(id) => <GroupView groupId={id()} />}
      </Show>

      <Show when={!selected()}>
        <div class="min-h-0 flex-1 overflow-auto px-8 py-10 fa-scroll">
          <div class="mx-auto max-w-2xl">
            <div class="mb-6 flex items-center justify-between">
              <div>
                <h1 class="font-display text-2xl font-bold tracking-tight">Your spaces</h1>
                <p class="mt-1 text-sm text-muted">Pick a space, or create a new one.</p>
              </div>
              <button
                type="button"
                class="btn-accent"
                onClick={() => setShowCreate(true)}
                data-testid="open-create-group"
              >
                <Icon name="plus" size={14} />
                New space
              </button>
            </div>

            <Show when={!groups.isLoading} fallback={<p class="text-sm text-muted">Loading…</p>}>
              <Show
                when={(groups.data ?? []).length > 0}
                fallback={
                  <div
                    class="rounded-lg border-[1.5px] border-dashed border-border-strong p-8 text-center"
                    data-testid="groups-empty"
                  >
                    <p class="text-sm text-muted">You're not in any spaces yet.</p>
                    <button
                      type="button"
                      class="btn-accent mt-4"
                      onClick={() => setShowCreate(true)}
                      data-testid="empty-create-group"
                    >
                      Create a space
                    </button>
                  </div>
                }
              >
                <ul class="grid grid-cols-2 gap-3" data-testid="my-groups-list">
                  <For each={groups.data ?? []}>
                    {(grp) => (
                      <A
                        href={`/groups/${grp.id}`}
                        class="card-raised flex items-center gap-3 transition-transform hover:-translate-x-px hover:-translate-y-px"
                        data-testid="my-group-item"
                        data-group-name={grp.name}
                      >
                        <span class="fa-ava fa-ava--phosphor">
                          {grp.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate font-display text-sm font-bold tracking-tight">
                            {grp.name}
                          </span>
                          <span class="eyebrow">{grp.tier}</span>
                        </span>
                      </A>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>
          </div>
        </div>
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
