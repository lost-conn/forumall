/**
 * Group view (P8) — the "space" layout: a `pr-side` channel-list column (space
 * header w/ a dropdown for group management, grouped channels, a voice group,
 * and an identity footer) beside the main pane, which holds the open channel's
 * {@link ChatView} (or a join card / empty state). Members, requests, invites,
 * and settings open as overlays from the space-header dropdown — each gated by
 * the caller's role. Non-members get a join card honoring the group's joinPolicy.
 */
import type { Channel, Group, Member } from "@forumall/shared";
import { A } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import {
  type Component,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
} from "solid-js";
import { can, joinGroup, leaveGroup } from "../../lib/groups-api.ts";
import { session, sessionClient } from "../../stores/session.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { ChatView } from "../chat/ChatView.tsx";
import { CreateChannelModal, ManageChannelModal } from "./ChannelModals.tsx";
import { GroupAvatar } from "./GroupAvatar.tsx";
import { GroupSettingsModal } from "./GroupSettingsModal.tsx";
import { InvitesPanel } from "./InvitesPanel.tsx";
import { MembersPanel } from "./MembersPanel.tsx";
import { RequestsPanel } from "./RequestsPanel.tsx";
import { channelsQuery, groupQuery, membersQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, errorMessage } from "./ui.tsx";

/** Which management overlay is open (reached from the space-header dropdown). */
type MgmtPanel = "members" | "requests" | "invites" | null;

/** Pick the line icon for a channel by type (call channels → speaker). */
function channelIcon(type: string): IconName {
  return type === "call" || type === "voice"
    ? "speaker"
    : type === "article"
      ? "article"
      : type === "memo"
        ? "memo"
        : "hash";
}

/** Local-part of the signed-in actor for the identity footer. */
function selfName(): string {
  const a = session.actor ?? "";
  const at = a.indexOf("@");
  return at > 0 ? a.slice(0, at) : a;
}

export const GroupView: Component<{ groupId: string }> = (props) => {
  const groupId = () => props.groupId;
  const group = useQuery(() => groupQuery(groupId));
  const channels = useQuery(() => channelsQuery(groupId));
  const members = useQuery(() => membersQuery(groupId, () => true));
  const invalidate = useInvalidateGroup();

  const [menuOpen, setMenuOpen] = createSignal(false);
  const [mgmt, setMgmt] = createSignal<MgmtPanel>(null);
  const [showCreateChannel, setShowCreateChannel] = createSignal(false);
  const [manageChannel, setManageChannel] = createSignal<Channel | null>(null);
  const [openChat, setOpenChat] = createSignal<Channel | null>(null);
  // Mobile master-detail: on < md, show EITHER the channel list or the chat pane.
  // Start on the list (so the create-channel + manage controls are reachable and
  // the user picks a channel); opening one flips to the chat pane. Desktop keeps
  // both side-by-side (the responsive classes neutralize this).
  const [mobileChannels, setMobileChannels] = createSignal(true);
  const openChannel = (ch: Channel): void => {
    setOpenChat(ch);
    setMobileChannels(false);
  };
  const [showSettings, setShowSettings] = createSignal(false);
  const [joinBusy, setJoinBusy] = createSignal(false);
  const [joinError, setJoinError] = createSignal<string | null>(null);
  const [joinState, setJoinState] = createSignal<"pending" | "invite-required" | null>(null);

  const myRole = createMemo<string | undefined>(() => {
    const me = (members.data ?? []).find((m: Member) => m.user === session.actor);
    return me?.role;
  });
  const isMember = () => myRole() !== undefined;
  const isOwner = () => myRole() === "owner";
  const g = (): Group | undefined => group.data;
  const canManage = () => can("manage", myRole(), g()?.permissions);
  const canModerate = () => can("moderate", myRole(), g()?.permissions);
  const canPost = () => can("post", myRole(), g()?.permissions);
  const canPostKind = (channel: Channel, kind: "memo" | "article"): boolean => {
    const cp = channel.permissions as Record<string, string[] | undefined> | undefined;
    const key = `post:${kind}`;
    if (cp?.[key]) return can(key, myRole(), cp as never);
    return canPost();
  };

  const textChannels = () => (channels.data ?? []).filter((c) => c.type === "text");

  // Reset the open channel when the group changes; auto-open the first text
  // channel so the space lands on a usable stream (matches the design default).
  createEffect(
    on(groupId, () => {
      setOpenChat(null);
      setMenuOpen(false);
      setMgmt(null);
    }),
  );
  createEffect(() => {
    if (!openChat() && textChannels().length > 0) setOpenChat(textChannels()[0] ?? null);
  });

  const closeMenu = () => setMenuOpen(false);
  const openMgmt = (panel: MgmtPanel) => {
    setMgmt(panel);
    closeMenu();
  };

  const doJoin = async () => {
    const grp = g();
    if (!grp) return;
    setJoinBusy(true);
    setJoinError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      const outcome = await joinGroup(client, grp.id);
      if (outcome.kind === "request") setJoinState("pending");
      else if (outcome.kind === "invite-required") setJoinState("invite-required");
      else setJoinState(null);
      invalidate(grp.id);
    } catch (err) {
      setJoinError(errorMessage(err, "Could not join the group."));
    } finally {
      setJoinBusy(false);
    }
  };

  const doLeave = async () => {
    const grp = g();
    if (!grp) return;
    closeMenu();
    if (!confirm(`Leave "${grp.name}"?`)) return;
    setJoinBusy(true);
    setJoinError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      await leaveGroup(client, grp.id);
      invalidate(grp.id);
    } catch (err) {
      setJoinError(errorMessage(err, "Could not leave the group."));
    } finally {
      setJoinBusy(false);
    }
  };

  return (
    <Show
      when={!group.isLoading}
      fallback={<div class="grid flex-1 place-items-center text-sm text-muted">Loading group…</div>}
    >
      <Show
        when={g()}
        fallback={
          <div class="grid flex-1 place-items-center p-8 text-center">
            <p class="text-sm text-danger" data-testid="group-load-error">
              {group.error ? "Could not load this group." : "Group not found."}
            </p>
          </div>
        }
      >
        {(grp) => (
          <div class="flex min-h-0 flex-1">
            {/* ---- pr-side: channel list ---- */}
            <aside
              class="w-full shrink-0 flex-col border-r border-border bg-surface md:flex md:w-[244px]"
              classList={{ flex: mobileChannels(), hidden: !mobileChannels() }}
            >
              {/* Space header + management dropdown */}
              <div class="relative">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 border-b border-border px-3.5 py-[13px] text-left hover:bg-surface-2"
                  data-testid="space-menu-toggle"
                  aria-expanded={menuOpen()}
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  <GroupAvatar
                    name={grp().name}
                    avatar={grp().avatar}
                    class="h-6 w-6 text-[11px]"
                  />
                  <span
                    class="truncate font-display text-[15px] font-bold tracking-tight text-ink"
                    data-testid="group-name-heading"
                  >
                    {grp().name}
                  </span>
                  <span class="ml-auto text-muted">
                    <Icon name="chevDown" size={15} />
                  </span>
                </button>

                <Show when={menuOpen()}>
                  <button
                    type="button"
                    class="fixed inset-0 z-20 cursor-default"
                    aria-label="Close menu"
                    onClick={closeMenu}
                  />
                  <div
                    class="absolute inset-x-2 top-full z-30 mt-1 overflow-hidden rounded-md border-[1.5px] border-border-strong bg-surface shadow-[3px_3px_0_var(--shadow-col)]"
                    data-testid="space-menu"
                  >
                    <Show when={canManage()}>
                      <SpaceMenuItem
                        icon="gear"
                        label="Group settings"
                        testid="open-settings"
                        onClick={() => {
                          setShowSettings(true);
                          closeMenu();
                        }}
                      />
                    </Show>
                    <Show when={isMember() || ["public", "discoverable"].includes(grp().tier)}>
                      <SpaceMenuItem
                        icon="users"
                        label="Members"
                        testid="tab-members"
                        onClick={() => openMgmt("members")}
                      />
                    </Show>
                    <Show when={canManage() || canModerate()}>
                      <SpaceMenuItem
                        icon="bell"
                        label="Requests"
                        testid="tab-requests"
                        onClick={() => openMgmt("requests")}
                      />
                    </Show>
                    <Show when={canManage()}>
                      <SpaceMenuItem
                        icon="link"
                        label="Invites"
                        testid="tab-invites"
                        onClick={() => openMgmt("invites")}
                      />
                    </Show>
                    <Show when={isMember() && !isOwner()}>
                      <SpaceMenuItem
                        icon="x"
                        label="Leave group"
                        testid="leave-group"
                        danger
                        onClick={doLeave}
                      />
                    </Show>
                  </div>
                </Show>
              </div>

              {/* Channels */}
              <div class="min-h-0 flex-1 overflow-auto px-2 py-2 fa-scroll">
                <div class="flex items-center gap-1.5 px-2 pt-2 pb-1">
                  <span class="eyebrow flex-1">Channels</span>
                  <Show when={canManage()}>
                    <button
                      type="button"
                      class="text-muted hover:text-ink"
                      onClick={() => setShowCreateChannel(true)}
                      data-testid="open-create-channel"
                      aria-label="New channel"
                      title="New channel"
                    >
                      <Icon name="plus" size={15} />
                    </button>
                  </Show>
                </div>

                <Show
                  when={!channels.isLoading}
                  fallback={<p class="px-2 text-sm text-muted">Loading channels…</p>}
                >
                  <Show
                    when={(channels.data ?? []).length > 0}
                    fallback={
                      <p class="px-2 text-xs text-faint" data-testid="channels-empty">
                        No channels you can see yet.
                      </p>
                    }
                  >
                    <ul class="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="channels-list">
                      <For each={channels.data ?? []}>
                        {(ch) => (
                          <li
                            class="group flex items-center gap-[9px] rounded-md border-[1.5px] border-transparent px-[9px] py-1.5 font-mono text-[13px] transition-colors"
                            classList={{
                              "border-accent bg-accent-soft text-accent": openChat()?.id === ch.id,
                              "text-muted hover:(bg-surface-2 text-ink)": openChat()?.id !== ch.id,
                            }}
                            data-testid="channel-row"
                            data-channel-name={ch.name ?? ch.id}
                          >
                            <Icon name={channelIcon(ch.type)} size={15} />
                            <button
                              type="button"
                              class="min-w-0 flex-1 truncate text-left disabled:cursor-default"
                              data-testid="open-channel"
                              disabled={ch.type !== "text"}
                              onClick={() => ch.type === "text" && openChannel(ch)}
                            >
                              <span class="truncate" data-testid="channel-name-label">
                                {ch.name ?? ch.id}
                              </span>
                            </button>
                            <Show when={ch.tier !== "group"}>
                              <Icon name="lock" size={11} />
                            </Show>
                            <Show when={canManage()}>
                              <button
                                type="button"
                                class="p-1 text-faint opacity-100 transition-opacity hover:text-ink md:p-0 md:opacity-0 md:group-hover:opacity-100"
                                onClick={() => setManageChannel(ch)}
                                data-testid="manage-channel"
                                aria-label="Manage channel"
                              >
                                <Icon name="gear" size={13} />
                              </button>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Show>

                {/* Voice group — modeled but deferred (§9). */}
                <div class="flex items-center gap-1.5 px-2 pt-4 pb-1">
                  <span class="eyebrow flex-1">Voice</span>
                </div>
                <div
                  class="flex items-center gap-2 rounded-md px-2 py-1.5 font-mono text-[13px] text-faint"
                  title="Voice channels are coming soon"
                >
                  <Icon name="speaker" size={15} />
                  <span class="flex-1">Lounge</span>
                  <span class="fa-meta">soon</span>
                </div>
              </div>

              {/* Identity footer */}
              <div class="flex items-center gap-[9px] border-t border-border bg-surface-2 px-[11px] py-[9px]">
                <span class="fa-ava fa-ava--sm">{selfName().slice(0, 1).toUpperCase()}</span>
                <div class="min-w-0 flex-1 leading-[1.15]">
                  <div class="truncate font-body text-[13px] font-semibold text-ink">
                    {selfName()}
                  </div>
                  <div class="truncate font-mono text-[11px] text-accent">@{session.host}</div>
                </div>
                <button
                  type="button"
                  class="grid h-[30px] w-[30px] place-items-center rounded-sm text-muted hover:(bg-surface text-ink)"
                  title="Microphone"
                  aria-label="Microphone"
                  tabindex={-1}
                >
                  <Icon name="mic" size={15} />
                </button>
                <A
                  href="/settings"
                  class="grid h-[30px] w-[30px] place-items-center rounded-sm text-muted hover:(bg-surface text-ink)"
                  title="Settings"
                >
                  <Icon name="gear" size={15} />
                </A>
              </div>
            </aside>

            {/* ---- main pane ---- */}
            <div
              class="min-h-0 flex-1 flex-col md:flex"
              classList={{ flex: !mobileChannels(), hidden: mobileChannels() }}
            >
              {/* Mobile-only back bar to return to the channel list. */}
              <button
                type="button"
                class="flex items-center gap-1 border-b border-border px-4 py-2.5 text-left text-sm text-muted hover:text-ink md:hidden"
                onClick={() => setMobileChannels(true)}
                data-testid="mobile-back-to-channels"
              >
                <Icon name="chevLeft" size={16} />
                Channels
              </button>
              <Show when={!isMember()}>
                <JoinCard
                  group={grp()}
                  busy={joinBusy()}
                  state={joinState()}
                  error={joinError()}
                  onJoin={doJoin}
                />
              </Show>

              <Switch>
                <Match when={openChat()}>
                  {(ch) => (
                    <ChatView
                      channel={ch()}
                      canPost={isMember() && canPost()}
                      canPostMemo={isMember() && canPostKind(ch(), "memo")}
                      canPostArticle={isMember() && canPostKind(ch(), "article")}
                      canModerate={canModerate()}
                    />
                  )}
                </Match>
                <Match when={true}>
                  <div class="grid flex-1 place-items-center p-8 text-center">
                    <p class="text-sm text-muted">
                      {textChannels().length > 0
                        ? "Select a channel to start."
                        : "No channels yet."}
                    </p>
                  </div>
                </Match>
              </Switch>
            </div>

            {/* ---- overlays ---- */}
            <Show when={showCreateChannel()}>
              <CreateChannelModal groupId={grp().id} onClose={() => setShowCreateChannel(false)} />
            </Show>
            <Show when={manageChannel()}>
              {(ch) => (
                <ManageChannelModal
                  groupId={grp().id}
                  channel={ch()}
                  onClose={() => setManageChannel(null)}
                />
              )}
            </Show>
            <Show when={showSettings()}>
              <GroupSettingsModal
                group={grp()}
                isOwner={isOwner}
                onClose={() => setShowSettings(false)}
              />
            </Show>
            <Show when={mgmt()}>
              <MgmtModal title={mgmtTitle(mgmt())} onClose={() => setMgmt(null)}>
                <Switch>
                  <Match when={mgmt() === "members"}>
                    <MembersPanel group={grp()} myRole={myRole} />
                  </Match>
                  <Match when={mgmt() === "requests"}>
                    <RequestsPanel group={grp()} enabled={() => canManage() || canModerate()} />
                  </Match>
                  <Match when={mgmt() === "invites"}>
                    <InvitesPanel group={grp()} enabled={canManage} />
                  </Match>
                </Switch>
              </MgmtModal>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
};

function mgmtTitle(p: MgmtPanel): string {
  return p === "members" ? "Members" : p === "requests" ? "Join requests" : "Invites";
}

const SpaceMenuItem: Component<{
  icon: IconName;
  label: string;
  testid: string;
  danger?: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    class="flex w-full items-center gap-2.5 px-3 py-2 text-left font-mono text-[13px] transition-colors hover:bg-surface-2"
    classList={{ "text-ink": !props.danger, "text-danger": props.danger }}
    data-testid={props.testid}
    onClick={props.onClick}
  >
    <Icon name={props.icon} size={14} />
    {props.label}
  </button>
);

/** A centered modal hosting a management panel (members / requests / invites). */
const MgmtModal: Component<{ title: string; onClose: () => void; children: unknown }> = (props) => (
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
    role="presentation"
    onClick={(e) => {
      if (e.target === e.currentTarget) props.onClose();
    }}
    onKeyDown={(e) => {
      if (e.key === "Escape") props.onClose();
    }}
  >
    <div class="card max-h-[80vh] w-full max-w-2xl overflow-auto" data-testid="mgmt-modal">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-display text-sm font-bold tracking-tight">{props.title}</h2>
        <button
          type="button"
          class="text-faint hover:text-ink"
          aria-label="Close"
          onClick={props.onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      {props.children as never}
    </div>
  </div>
);

const JoinCard: Component<{
  group: Group;
  busy: boolean;
  state: "pending" | "invite-required" | null;
  error: string | null;
  onJoin: () => void;
}> = (props) => (
  <div
    class="m-6 rounded-lg border-[1.5px] border-border-strong bg-surface-2 p-4"
    data-testid="join-card"
  >
    <Switch>
      <Match when={props.state === "pending"}>
        <p class="text-sm text-accent" data-testid="join-pending">
          Your request to join is pending approval.
        </p>
      </Match>
      <Match when={props.state === "invite-required" || props.group.joinPolicy === "invite"}>
        <p class="text-sm text-muted" data-testid="join-invite-required">
          This group is invite-only. Open an invite link to join.
        </p>
      </Match>
      <Match when={true}>
        <div class="flex items-center justify-between gap-4">
          <p class="text-sm text-muted">
            {props.group.joinPolicy === "open"
              ? "You're not a member yet — join to participate."
              : "Joining this group requires approval."}
          </p>
          <button
            type="button"
            class="btn-accent px-4 py-1.5 text-xs"
            onClick={props.onJoin}
            disabled={props.busy}
            data-testid="join-group"
          >
            {props.busy
              ? "Joining…"
              : props.group.joinPolicy === "request"
                ? "Request to join"
                : "Join"}
          </button>
        </div>
      </Match>
    </Switch>
    <ErrorLine message={props.error} testid="join-error" />
  </div>
);
