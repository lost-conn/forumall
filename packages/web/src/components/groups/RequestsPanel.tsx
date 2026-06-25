/**
 * Join-request approvals (P8, §5.7). Managers/moderators see pending requests and
 * approve (→ member) or deny them.
 */
import type { Group } from "@forumall/shared";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Show, createSignal } from "solid-js";
import { approveJoinRequest, denyJoinRequest } from "../../lib/groups-api.ts";
import { sessionClient } from "../../stores/session.ts";
import { EmptyState } from "../shared/EmptyState.tsx";
import { requestsQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, errorMessage } from "./ui.tsx";

export const RequestsPanel: Component<{ group: Group; enabled: () => boolean }> = (props) => {
  const groupId = () => props.group.id;
  const requests = useQuery(() => requestsQuery(groupId, props.enabled));
  const invalidate = useInvalidateGroup();
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      invalidate(groupId());
    } catch (err) {
      setError(errorMessage(err, "Action failed."));
    } finally {
      setBusy(null);
    }
  };

  const approve = (id: string) => {
    const client = sessionClient();
    if (!client) return;
    return act(id, () => approveJoinRequest(client, groupId(), id));
  };
  const deny = (id: string) => {
    const client = sessionClient();
    if (!client) return;
    return act(id, () => denyJoinRequest(client, groupId(), id));
  };

  return (
    <section data-testid="requests-panel">
      <ErrorLine message={error()} testid="requests-error" />
      <Show
        when={!requests.isLoading}
        fallback={<p class="text-sm text-muted">Loading requests…</p>}
      >
        <Show
          when={(requests.data ?? []).length > 0}
          fallback={<EmptyState testid="requests-empty" message="No pending requests." />}
        >
          <ul
            class="flex flex-col divide-y divide-dashed divide-border"
            data-testid="requests-list"
          >
            <For each={requests.data ?? []}>
              {(r) => (
                <li class="flex items-center gap-3 py-3" data-testid="request-row">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm text-ink font-mono" data-testid="request-user">
                      {r.user}
                    </div>
                    <Show when={r.message}>
                      <p class="truncate text-xs text-faint">{r.message}</p>
                    </Show>
                  </div>
                  <button
                    type="button"
                    class="btn-accent px-3 py-1.5 text-xs"
                    disabled={busy() === r.id}
                    onClick={() => approve(r.id)}
                    data-testid="approve-request"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    class="btn-ghost px-3 py-1.5 text-xs hover:(border-danger text-danger)"
                    disabled={busy() === r.id}
                    onClick={() => deny(r.id)}
                    data-testid="deny-request"
                  >
                    Deny
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
};
