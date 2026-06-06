/**
 * Group settings (P8, §5.5). Managers edit name/description/tier/joinPolicy and
 * the permission map; the owner can delete the group. Saves go through PATCH
 * `/api/groups/{id}`; delete through DELETE (owner only).
 */
import type { Group, GroupPermissions, JoinPolicy } from "@forumall/shared";
import { useNavigate } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Show, createSignal } from "solid-js";
import { deleteGroup, updateGroup } from "../../lib/groups-api.ts";
import { sessionClient } from "../../stores/session.ts";
import { tiersQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, Field, Modal, TierSelect, errorMessage } from "./ui.tsx";

const JOIN_POLICIES: JoinPolicy[] = ["open", "request", "invite"];

function roleList(s: string): string[] {
  return s
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}
function joinRoles(roles: readonly string[] | undefined): string {
  return (roles ?? []).join(", ");
}

export const GroupSettingsModal: Component<{
  group: Group;
  isOwner: () => boolean;
  onClose: () => void;
}> = (props) => {
  const tiers = useQuery(tiersQuery);
  const invalidate = useInvalidateGroup();
  const navigate = useNavigate();

  const [name, setName] = createSignal(props.group.name);
  const [description, setDescription] = createSignal(props.group.description ?? "");
  const [tier, setTier] = createSignal(props.group.tier);
  const [joinPolicy, setJoinPolicy] = createSignal<JoinPolicy>(props.group.joinPolicy);
  const [post, setPost] = createSignal(joinRoles(props.group.permissions.post));
  const [moderate, setModerate] = createSignal(joinRoles(props.group.permissions.moderate));
  const [manage, setManage] = createSignal(joinRoles(props.group.permissions.manage));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const save = async (e: Event) => {
    e.preventDefault();
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
      await updateGroup(client, props.group.id, {
        name: name().trim(),
        description: description().trim(),
        tier: tier(),
        joinPolicy: joinPolicy(),
        permissions,
      });
      invalidate(props.group.id);
      props.onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not save settings."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${props.group.name}"? This permanently removes it.`)) return;
    setBusy(true);
    setError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      await deleteGroup(client, props.group.id);
      invalidate(props.group.id);
      props.onClose();
      navigate("/groups");
    } catch (err) {
      setError(errorMessage(err, "Could not delete the group."));
      setBusy(false);
    }
  };

  return (
    <Modal title="Group settings" onClose={props.onClose} testid="group-settings-modal">
      <form class="flex flex-col gap-4" onSubmit={save}>
        <Field label="Name">
          <input
            class="input"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            disabled={busy()}
            data-testid="settings-name"
          />
        </Field>
        <Field label="Description">
          <textarea
            class="input min-h-16 resize-y"
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
            disabled={busy()}
          />
        </Field>
        <Field label="Tier">
          <TierSelect tiers={tiers.data} value={tier()} onChange={setTier} testid="settings-tier" />
        </Field>
        <Field label="Join policy">
          <select
            class="input capitalize"
            value={joinPolicy()}
            onChange={(e) => setJoinPolicy(e.currentTarget.value as JoinPolicy)}
            data-testid="settings-join-policy"
          >
            <For each={JOIN_POLICIES}>{(p) => <option value={p}>{p}</option>}</For>
          </select>
        </Field>

        <details class="text-xs text-muted">
          <summary class="cursor-pointer select-none">Permissions</summary>
          <div class="mt-3 flex flex-col gap-3">
            <Field label="Post">
              <input
                class="input font-mono text-xs"
                value={post()}
                onInput={(e) => setPost(e.currentTarget.value)}
              />
            </Field>
            <Field label="Moderate">
              <input
                class="input font-mono text-xs"
                value={moderate()}
                onInput={(e) => setModerate(e.currentTarget.value)}
              />
            </Field>
            <Field label="Manage">
              <input
                class="input font-mono text-xs"
                value={manage()}
                onInput={(e) => setManage(e.currentTarget.value)}
              />
            </Field>
          </div>
        </details>

        <ErrorLine message={error()} testid="settings-error" />

        <div class="flex items-center justify-between gap-2">
          <Show when={props.isOwner()}>
            <button
              type="button"
              class="btn-ghost text-xs hover:(border-danger text-danger)"
              onClick={remove}
              disabled={busy()}
              data-testid="delete-group"
            >
              Delete group
            </button>
          </Show>
          <div class="ml-auto flex gap-2">
            <button type="button" class="btn-ghost" onClick={props.onClose} disabled={busy()}>
              Cancel
            </button>
            <button type="submit" class="btn-accent" disabled={busy()} data-testid="save-settings">
              {busy() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
};
