/**
 * Create-group modal (P8, §5.5). Name, description, tier (populated from
 * `GET /api/tiers`), join policy, and default permissions. On success the caller
 * becomes the group `owner`; we invalidate the group list + route into it.
 */
import type { GroupPermissions, JoinPolicy } from "@forumall/shared";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Show, createSignal } from "solid-js";
import { createGroup } from "../../lib/groups-api.ts";
import { sessionClient } from "../../stores/session.ts";
import { tiersQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, Field, Modal, TierSelect, errorMessage } from "./ui.tsx";

const JOIN_POLICIES: { id: JoinPolicy; label: string; hint: string }[] = [
  { id: "open", label: "Open", hint: "Anyone can join immediately." },
  { id: "request", label: "Request", hint: "Joins require approval." },
  { id: "invite", label: "Invite only", hint: "Members join via an invite link." },
];

/** Comma-separated role list → string[] (trimmed, non-empty). */
function roleList(s: string): string[] {
  return s
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

export const CreateGroupModal: Component<{
  onClose: () => void;
  onCreated: (groupId: string) => void;
}> = (props) => {
  const tiers = useQuery(tiersQuery);
  const invalidate = useInvalidateGroup();

  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [tier, setTier] = createSignal("private");
  const [joinPolicy, setJoinPolicy] = createSignal<JoinPolicy>("invite");
  const [post, setPost] = createSignal("member");
  const [moderate, setModerate] = createSignal("admin");
  const [manage, setManage] = createSignal("admin");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!name().trim()) {
      setError("A group name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      const permissions: GroupPermissions = {
        post: roleList(post()),
        moderate: roleList(moderate()),
        manage: roleList(manage()),
      };
      const group = await createGroup(client, {
        name: name().trim(),
        ...(description().trim() ? { description: description().trim() } : {}),
        tier: tier(),
        joinPolicy: joinPolicy(),
        permissions,
      });
      invalidate(group.id);
      props.onCreated(group.id);
    } catch (err) {
      setError(errorMessage(err, "Could not create the group."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create a group" onClose={props.onClose} testid="create-group-modal">
      <form class="flex flex-col gap-4" onSubmit={submit}>
        <Field label="Name">
          <input
            class="input"
            name="name"
            placeholder="My community"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            disabled={busy()}
            data-testid="group-name"
          />
        </Field>

        <Field label="Description" hint="(optional)">
          <textarea
            class="input min-h-16 resize-y"
            name="description"
            placeholder="What's this group about?"
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
            disabled={busy()}
            data-testid="group-description"
          />
        </Field>

        <Field label="Tier">
          <TierSelect
            tiers={tiers.data}
            value={tier()}
            onChange={setTier}
            name="tier"
            testid="group-tier"
          />
        </Field>

        <Field label="Join policy">
          <div class="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1 text-xs">
            <For each={JOIN_POLICIES}>
              {(p) => (
                <button
                  type="button"
                  class="rounded-md px-2 py-1.5 font-medium transition-colors"
                  classList={{
                    "bg-accent text-white": joinPolicy() === p.id,
                    "text-muted hover:text-ink": joinPolicy() !== p.id,
                  }}
                  onClick={() => setJoinPolicy(p.id)}
                  data-testid={`join-policy-${p.id}`}
                >
                  {p.label}
                </button>
              )}
            </For>
          </div>
          <Show when={JOIN_POLICIES.find((p) => p.id === joinPolicy())}>
            {(p) => <p class="mt-1 text-xs text-faint">{p().hint}</p>}
          </Show>
        </Field>

        <details class="text-xs text-muted">
          <summary class="cursor-pointer select-none">Default permissions</summary>
          <div class="mt-3 flex flex-col gap-3">
            <Field label="Who can post" hint="(comma-separated roles)">
              <input
                class="input font-mono text-xs"
                value={post()}
                onInput={(e) => setPost(e.currentTarget.value)}
                disabled={busy()}
              />
            </Field>
            <Field label="Who can moderate">
              <input
                class="input font-mono text-xs"
                value={moderate()}
                onInput={(e) => setModerate(e.currentTarget.value)}
                disabled={busy()}
              />
            </Field>
            <Field label="Who can manage">
              <input
                class="input font-mono text-xs"
                value={manage()}
                onInput={(e) => setManage(e.currentTarget.value)}
                disabled={busy()}
              />
            </Field>
          </div>
        </details>

        <ErrorLine message={error()} testid="create-group-error" />

        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" onClick={props.onClose} disabled={busy()}>
            Cancel
          </button>
          <button
            type="submit"
            class="btn-accent"
            disabled={busy()}
            data-testid="create-group-submit"
          >
            {busy() ? "Creating…" : "Create group"}
          </button>
        </div>
      </form>
    </Modal>
  );
};
