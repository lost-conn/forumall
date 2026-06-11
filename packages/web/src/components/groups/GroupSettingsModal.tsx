/**
 * Group settings (P8, §5.5 / §5.2). Managers edit name/description/tier/
 * joinPolicy, the group's **role catalogue** (custom roles + colors) and the
 * **permission matrix** (which roles hold each action); the owner can delete the
 * group. Permissions use exact membership — a role holds an action iff it is
 * ticked (no rank inheritance); `owner` implicitly holds everything. Saves go
 * through PATCH `/api/groups/{id}`; delete through DELETE (owner only).
 */
import type { Group, GroupPermissions, JoinPolicy, RoleDefinition } from "@forumall/shared";
import { useNavigate } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Show, createMemo, createSignal } from "solid-js";
import { resolveAttachmentUrl, uploadMedia } from "../../lib/chat-api.ts";
import { deleteGroup, updateGroup } from "../../lib/groups-api.ts";
import { sessionClient } from "../../stores/session.ts";
import { tiersQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, Field, Modal, TierSelect, errorMessage } from "./ui.tsx";

const JOIN_POLICIES: JoinPolicy[] = ["open", "request", "invite"];

/** The canonical actions the matrix always offers (the group MAY have more). */
const CANONICAL_ACTIONS = ["post", "moderate", "manage"];
/** Palette cycled through when minting a fresh custom role. */
const ROLE_COLORS = ["#be7d37", "#37be7d", "#377dbe", "#be37a8", "#bea837", "#7d37be"];

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
  const [avatar, setAvatar] = createSignal(props.group.avatar ?? "");
  const [uploading, setUploading] = createSignal(false);
  let avatarInput: HTMLInputElement | undefined;
  const [tier, setTier] = createSignal(props.group.tier);
  const [joinPolicy, setJoinPolicy] = createSignal<JoinPolicy>(props.group.joinPolicy);

  // --- Role catalogue + permission matrix -----------------------------------
  // Seed the catalogue from the group, merging in any role referenced by the
  // permission map but missing from `roles` (so it stays visible/editable).
  const initialPerms = props.group.permissions ?? {};
  const seededRoles: RoleDefinition[] = [...(props.group.roles ?? [])];
  const seededNames = new Set(seededRoles.map((r) => r.name));
  for (const action of Object.keys(initialPerms)) {
    for (const role of initialPerms[action] ?? []) {
      if (role !== "owner" && !seededNames.has(role)) {
        seededRoles.push({ name: role });
        seededNames.add(role);
      }
    }
  }

  const [roles, setRoles] = createSignal<RoleDefinition[]>(seededRoles);
  // perms: action -> roles[]. Cloned so edits don't mutate the query cache.
  const [perms, setPerms] = createSignal<Record<string, string[]>>(
    Object.fromEntries(Object.keys(initialPerms).map((a) => [a, [...(initialPerms[a] ?? [])]])),
  );
  const [newRole, setNewRole] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const actions = createMemo(() => [...new Set([...CANONICAL_ACTIONS, ...Object.keys(perms())])]);

  const isGranted = (action: string, role: string) => (perms()[action] ?? []).includes(role);
  const toggle = (action: string, role: string) => {
    setPerms((prev) => {
      const current = prev[action] ?? [];
      const next = current.includes(role) ? current.filter((r) => r !== role) : [...current, role];
      return { ...prev, [action]: next };
    });
  };

  const addRole = () => {
    const trimmed = newRole().trim();
    if (!trimmed) return;
    if (trimmed === "owner" || roles().some((r) => r.name === trimmed)) {
      setError(`Role "${trimmed}" already exists.`);
      return;
    }
    const color = ROLE_COLORS[roles().length % ROLE_COLORS.length];
    setRoles((prev) => [...prev, { name: trimmed, color }]);
    setNewRole("");
    setError(null);
  };
  const removeRole = (name: string) => {
    setRoles((prev) => prev.filter((r) => r.name !== name));
    // Strip the removed role from every action's grant list.
    setPerms((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([a, list]) => [a, list.filter((r) => r !== name)]),
      ),
    );
  };
  const setColor = (name: string, color: string) => {
    setRoles((prev) => prev.map((r) => (r.name === name ? { ...r, color } : r)));
  };

  // Upload a chosen image as the group avatar (§5.8 signed multipart, via the
  // binary-safe `uploadMedia`). The returned attachment `url` is an https:// URL
  // this provider hosts, satisfying the avatar field's https-only constraint;
  // it's staged in the `avatar` signal and persisted by the normal Save flow.
  const onPickAvatar = async (file: File): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setUploading(true);
    setError(null);
    try {
      const att = await uploadMedia(client, file);
      setAvatar(att.url);
    } catch (err) {
      setError(errorMessage(err, "Could not upload the image."));
    } finally {
      setUploading(false);
      if (avatarInput) avatarInput.value = "";
    }
  };

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      // `avatar` is constrained to an https:// URI server-side, so an empty
      // field must be omitted (not sent as "") or the update is rejected.
      const avatarUrl = avatar().trim();
      if (avatarUrl && !/^https:\/\//.test(avatarUrl)) {
        setError("Avatar must be an https:// URL.");
        return;
      }
      // Only persist grants for roles still in the catalogue; drop empty actions.
      const known = new Set(roles().map((r) => r.name));
      const permissions: GroupPermissions = {};
      for (const action of actions()) {
        const list = (perms()[action] ?? []).filter((r) => known.has(r));
        permissions[action] = list;
      }
      await updateGroup(client, props.group.id, {
        name: name().trim(),
        description: description().trim(),
        tier: tier(),
        joinPolicy: joinPolicy(),
        permissions,
        roles: roles(),
        ...(avatarUrl ? { avatar: avatarUrl } : {}),
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
        <Field label="Avatar">
          <div class="flex items-center gap-3">
            <span class="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-base text-faint">
              <Show
                when={avatar().trim()}
                fallback={(name() || props.group.name || "?").slice(0, 1).toUpperCase()}
              >
                <img
                  src={resolveAttachmentUrl(avatar().trim())}
                  alt=""
                  class="h-full w-full object-cover"
                  data-testid="settings-avatar-preview"
                />
              </Show>
            </span>
            <button
              type="button"
              class="btn-ghost px-3 py-1.5 text-xs"
              data-testid="settings-avatar-upload"
              disabled={busy() || uploading()}
              onClick={() => avatarInput?.click()}
            >
              {uploading() ? "Uploading…" : "Upload image"}
            </button>
            <Show when={avatar().trim()}>
              <button
                type="button"
                class="btn-ghost px-3 py-1.5 text-xs hover:(border-danger text-danger)"
                data-testid="settings-avatar-clear"
                disabled={busy() || uploading()}
                onClick={() => setAvatar("")}
              >
                Remove
              </button>
            </Show>
            <input
              ref={avatarInput}
              type="file"
              accept="image/*"
              class="hidden"
              data-testid="settings-avatar-file"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file) void onPickAvatar(file);
              }}
            />
          </div>
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

        <details class="text-xs text-muted" data-testid="roles-permissions">
          <summary class="cursor-pointer select-none">Roles &amp; permissions</summary>

          {/* Role catalogue */}
          <div class="mt-3 flex flex-col gap-2">
            <p class="text-faint">
              Roles you can assign to members. <span class="text-ink">owner</span> always holds
              every permission.
            </p>
            <ul class="flex flex-col gap-1.5" data-testid="role-catalogue">
              <For each={roles()}>
                {(r) => (
                  <li class="flex items-center gap-2">
                    <input
                      type="color"
                      class="h-6 w-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
                      value={r.color ?? "#888888"}
                      onInput={(e) => setColor(r.name, e.currentTarget.value)}
                      disabled={busy()}
                      aria-label={`Color for ${r.name}`}
                    />
                    <span class="flex-1 font-mono text-ink">{r.name}</span>
                    <button
                      type="button"
                      class="btn-ghost px-2 py-0.5 text-[10px] hover:(border-danger text-danger)"
                      onClick={() => removeRole(r.name)}
                      disabled={busy()}
                      data-testid="remove-role"
                    >
                      Remove
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <div class="flex items-center gap-2">
              <input
                class="input flex-1 text-xs"
                placeholder="New role name (e.g. moderator)"
                value={newRole()}
                onInput={(e) => setNewRole(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRole();
                  }
                }}
                disabled={busy()}
                data-testid="new-role-name"
              />
              <button
                type="button"
                class="btn-ghost px-3 py-1 text-xs"
                onClick={addRole}
                disabled={busy()}
                data-testid="add-role"
              >
                Add role
              </button>
            </div>
          </div>

          {/* Permission matrix: action × role (exact membership) */}
          <div class="mt-4 overflow-x-auto">
            <table class="w-full border-collapse text-left" data-testid="permission-matrix">
              <thead>
                <tr class="text-faint">
                  <th class="py-1 pr-3 font-medium">Action</th>
                  <For each={roles()}>
                    {(r) => (
                      <th class="px-2 py-1 text-center font-mono font-normal text-ink">{r.name}</th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={actions()}>
                  {(action) => (
                    <tr class="border-t border-dashed border-border">
                      <td class="py-1.5 pr-3 font-mono text-ink">{action}</td>
                      <For each={roles()}>
                        {(r) => (
                          <td class="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              class="cursor-pointer accent-accent"
                              checked={isGranted(action, r.name)}
                              onChange={() => toggle(action, r.name)}
                              disabled={busy()}
                              data-testid={`perm-${action}-${r.name}`}
                              aria-label={`${r.name} may ${action}`}
                            />
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
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
