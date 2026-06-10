/**
 * Member list + role management (P8, §5.7). Lists members with their roles;
 * managers can promote/demote and transfer ownership; moderators can kick. The
 * controls offered reflect the caller's role (client-side `can` hint) but the
 * server re-checks every mutation.
 */
import type { Group, Member } from "@forumall/shared";
import { useQuery } from "@tanstack/solid-query";
import {
  type Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  can,
  removeMember,
  roleHoldsAll,
  setMemberDisplayName,
  setMemberRole,
} from "../../lib/groups-api.ts";
import { subscribePresence } from "../../stores/presence-controller.ts";
import { displayNameForInGroup, setGroupDisplayName, warmProfiles } from "../../stores/profiles.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { PresenceDot } from "../social/PresenceDot.tsx";
import { membersQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, RoleBadge, errorMessage } from "./ui.tsx";

/** Canonical fallback when a group has no `roles` catalogue (transfer owner is a
 * distinct, owner-only action and is never an option here). */
const FALLBACK_ASSIGNABLE = ["admin", "member", "guest"];

export const MembersPanel: Component<{ group: Group; myRole: () => string | undefined }> = (
  props,
) => {
  const groupId = () => props.group.id;
  const members = useQuery(() => membersQuery(groupId, () => true));
  const invalidate = useInvalidateGroup();
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const canManage = () => can("manage", props.myRole(), props.group.permissions);
  const canModerate = () => can("moderate", props.myRole(), props.group.permissions);
  const isOwner = () => props.myRole() === "owner";
  /** May I set OTHER members' per-group nicknames? (server re-checks). */
  const canSetNicknames = () =>
    can("members.set-nickname", props.myRole(), props.group.permissions);

  // Which member's nickname editor is open, and its draft text.
  const [editingNick, setEditingNick] = createSignal<string | null>(null);
  const [nickDraft, setNickDraft] = createSignal("");

  /** Assignable roles from the group's catalogue (owner excluded — it transfers). */
  const assignable = createMemo(() => {
    const names = (props.group.roles ?? []).map((r) => r.name).filter((r) => r !== "owner");
    return names.length ? names : FALLBACK_ASSIGNABLE;
  });
  const roleColor = (role: string) => props.group.roles?.find((r) => r.name === role)?.color;
  /** Subset (self-protect) rule (§5.7): may I act on a member with this role? */
  const mayActOn = (role: string) => roleHoldsAll(props.myRole(), role, props.group.permissions);

  // Subscribe to live presence for every visible member while the panel is shown;
  // the ref-counted controller de-dupes overlap with other views (DMs, contacts).
  // Also populate the per-group nickname cache from the loaded member list.
  let disposeSub: (() => void) | null = null;
  createMemo(() => {
    const list = members.data ?? [];
    const actors = list.map((m: Member) => m.user);
    warmProfiles(actors);
    for (const m of list) setGroupDisplayName(groupId(), m.user, m.displayNameOverride);
    disposeSub?.();
    disposeSub = subscribePresence(sessionWs(), actors, session.actor);
  });
  onCleanup(() => disposeSub?.());

  // Reflect live `member.updated` events into the nickname cache while open.
  createEffect(() => {
    const ws = sessionWs();
    if (!ws) return;
    const off = ws.on("member.updated", (e) => {
      const data = (e as { data?: { groupId?: string; member?: Member } }).data;
      if (!data?.member || data.groupId !== groupId()) return;
      setGroupDisplayName(groupId(), data.member.user, data.member.displayNameOverride);
      invalidate(groupId());
    });
    onCleanup(off);
  });

  const submitNick = async (m: Member, clear = false) => {
    const client = sessionClient();
    if (!client) return;
    const value = clear ? null : nickDraft().trim() || null;
    await mutate(`nick:${m.user}`, () => setMemberDisplayName(client, groupId(), m.user, value));
    setEditingNick(null);
    setNickDraft("");
  };
  const openNickEditor = (m: Member) => {
    setNickDraft(m.displayNameOverride ?? "");
    setEditingNick(m.user);
  };

  const mutate = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
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

  const changeRole = (m: Member, role: string) => {
    const client = sessionClient();
    if (!client) return;
    return mutate(`role:${m.user}`, () => setMemberRole(client, groupId(), m.user, role));
  };
  const transferOwner = (m: Member) => {
    if (!confirm(`Transfer ownership to ${m.user}? You will become an admin.`)) return;
    const client = sessionClient();
    if (!client) return;
    return mutate(`owner:${m.user}`, () => setMemberRole(client, groupId(), m.user, "owner"));
  };
  const kick = (m: Member) => {
    if (!confirm(`Remove ${m.user} from the group?`)) return;
    const client = sessionClient();
    if (!client) return;
    return mutate(`kick:${m.user}`, () => removeMember(client, groupId(), m.user));
  };

  return (
    <section data-testid="members-panel">
      <ErrorLine message={error()} testid="members-error" />
      <Show when={!members.isLoading} fallback={<p class="text-sm text-muted">Loading members…</p>}>
        <Show
          when={!members.error}
          fallback={<p class="text-sm text-danger">Could not load members.</p>}
        >
          <ul class="flex flex-col divide-y divide-dashed divide-border" data-testid="members-list">
            <For each={members.data ?? []}>
              {(m) => {
                const isSelf = () => m.user === session.actor;
                return (
                  <li class="flex items-center gap-3 py-3" data-testid="member-row">
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
                      {displayNameForInGroup(m.user, groupId()).slice(0, 2).toUpperCase()}
                    </span>
                    <div class="min-w-0 flex-1">
                      <div
                        class="flex items-center gap-2 truncate text-sm text-ink"
                        data-testid="member-name"
                      >
                        <Show when={!isSelf()}>
                          <PresenceDot actor={m.user} />
                        </Show>
                        <span class="truncate font-semibold">
                          {displayNameForInGroup(m.user, groupId())}
                        </span>
                        <Show when={isSelf()}>
                          <span class="ml-1.5 text-xs text-faint">(you)</span>
                        </Show>
                      </div>
                      <div
                        class="truncate font-mono text-xs text-faint"
                        data-testid="member-handle"
                      >
                        {m.user}
                      </div>
                      <Show when={editingNick() === m.user}>
                        <form
                          class="mt-1.5 flex items-center gap-1.5"
                          data-testid="nickname-editor"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void submitNick(m);
                          }}
                        >
                          <input
                            class="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-ink"
                            value={nickDraft()}
                            placeholder="Nickname in this group"
                            maxLength={64}
                            disabled={busy() === `nick:${m.user}`}
                            onInput={(e) => setNickDraft(e.currentTarget.value)}
                            data-testid="nickname-input"
                          />
                          <button
                            type="submit"
                            class="btn-accent px-2 py-1 text-xs"
                            disabled={busy() === `nick:${m.user}`}
                            data-testid="nickname-save"
                          >
                            Save
                          </button>
                          <Show when={m.displayNameOverride}>
                            <button
                              type="button"
                              class="btn-ghost px-2 py-1 text-xs"
                              disabled={busy() === `nick:${m.user}`}
                              onClick={() => void submitNick(m, true)}
                              data-testid="nickname-clear"
                            >
                              Clear
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="btn-ghost px-2 py-1 text-xs"
                            onClick={() => setEditingNick(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      </Show>
                    </div>
                    <RoleBadge role={m.role} color={roleColor(m.role)} />
                    {/* Nickname: self always; others need members.set-nickname +
                        the subset rule (server re-checks). */}
                    <Show
                      when={
                        editingNick() !== m.user &&
                        (isSelf() || (canSetNicknames() && mayActOn(m.role)))
                      }
                    >
                      <button
                        type="button"
                        class="btn-ghost px-2 py-1 text-xs"
                        onClick={() => openNickEditor(m)}
                        data-testid="set-nickname"
                      >
                        {m.displayNameOverride ? "Edit nick" : "Nickname"}
                      </button>
                    </Show>
                    <Show
                      when={
                        !isSelf() &&
                        m.role !== "owner" &&
                        mayActOn(m.role) &&
                        (canManage() || canModerate())
                      }
                    >
                      <div class="flex items-center gap-1.5">
                        <Show when={canManage()}>
                          <select
                            class="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-ink"
                            value={m.role}
                            disabled={busy() === `role:${m.user}`}
                            onChange={(e) => changeRole(m, e.currentTarget.value)}
                            data-testid="member-role-select"
                          >
                            <For each={[...new Set([m.role, ...assignable()])]}>
                              {(r) => <option value={r}>{r}</option>}
                            </For>
                          </select>
                        </Show>
                        <Show when={isOwner()}>
                          <button
                            type="button"
                            class="btn-ghost px-2 py-1 text-xs"
                            disabled={busy() === `owner:${m.user}`}
                            onClick={() => transferOwner(m)}
                            data-testid="transfer-owner"
                          >
                            Make owner
                          </button>
                        </Show>
                        <Show when={canModerate()}>
                          <button
                            type="button"
                            class="btn-ghost px-2 py-1 text-xs hover:(border-danger text-danger)"
                            disabled={busy() === `kick:${m.user}`}
                            onClick={() => kick(m)}
                            data-testid="kick-member"
                          >
                            Kick
                          </button>
                        </Show>
                      </div>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
};
