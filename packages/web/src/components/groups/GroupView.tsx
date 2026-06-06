/**
 * Group view (P8). Shows a group's channels (visibility-filtered by the server)
 * plus tabbed panels for members, join-requests, invites, and settings — each
 * gated by the caller's role. Non-members get a join card that honors the
 * group's `joinPolicy` (open → immediate; request → pending; invite → prompt).
 */
import type { Channel, Group, Member } from "@forumall/shared";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { can, joinGroup, leaveGroup } from "../../lib/groups-api.ts";
import { session, sessionClient } from "../../stores/session.ts";
import { ChatView } from "../chat/ChatView.tsx";
import { CreateChannelModal, ManageChannelModal } from "./ChannelModals.tsx";
import { GroupSettingsModal } from "./GroupSettingsModal.tsx";
import { InvitesPanel } from "./InvitesPanel.tsx";
import { MembersPanel } from "./MembersPanel.tsx";
import { RequestsPanel } from "./RequestsPanel.tsx";
import { channelsQuery, groupQuery, membersQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, errorMessage } from "./ui.tsx";

type Tab = "channels" | "members" | "requests" | "invites";

const CHANNEL_GLYPH: Record<string, string> = { text: "#", call: "🔊" };

export const GroupView: Component<{ groupId: string }> = (props) => {
  const groupId = () => props.groupId;
  const group = useQuery(() => groupQuery(groupId));
  const channels = useQuery(() => channelsQuery(groupId));
  // Members drive the "am I a member / what's my role" decision. Always enabled
  // for a public group; for a private group a non-member's call 403s (handled).
  const members = useQuery(() => membersQuery(groupId, () => true));
  const invalidate = useInvalidateGroup();

  const [tab, setTab] = createSignal<Tab>("channels");
  const [showCreateChannel, setShowCreateChannel] = createSignal(false);
  const [manageChannel, setManageChannel] = createSignal<Channel | null>(null);
  const [openChat, setOpenChat] = createSignal<Channel | null>(null);
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
  /**
   * Client-side hint for posting a message kind in a channel (§5.2.1): the
   * channel's `post:<kind>` override if present, else the group `post` action.
   * The server is authoritative; this just gates the composer affordances.
   */
  const canPostKind = (channel: Channel, kind: "memo" | "article"): boolean => {
    const cp = channel.permissions as Record<string, string[] | undefined> | undefined;
    const key = `post:${kind}`;
    if (cp?.[key]) return can(key, myRole(), cp as never);
    return canPost();
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
    <div class="flex-1 overflow-auto">
      <Show when={!group.isLoading} fallback={<p class="p-8 text-sm text-muted">Loading group…</p>}>
        <Show
          when={g()}
          fallback={
            <div class="p-8">
              <p class="text-sm text-danger" data-testid="group-load-error">
                {group.error ? "Could not load this group." : "Group not found."}
              </p>
            </div>
          }
        >
          {(grp) => (
            <>
              <header class="border-b border-border px-8 py-5">
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <h1
                        class="truncate text-lg font-semibold tracking-tight"
                        data-testid="group-name-heading"
                      >
                        {grp().name}
                      </h1>
                      <span class="badge text-[10px] uppercase">{grp().tier}</span>
                    </div>
                    <Show when={grp().description}>
                      <p class="mt-0.5 truncate text-sm text-muted">{grp().description}</p>
                    </Show>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Show when={canManage()}>
                      <button
                        type="button"
                        class="btn-ghost px-3 py-1.5 text-xs"
                        onClick={() => setShowSettings(true)}
                        data-testid="open-settings"
                      >
                        Settings
                      </button>
                    </Show>
                    <Show when={isMember() && !isOwner()}>
                      <button
                        type="button"
                        class="btn-ghost px-3 py-1.5 text-xs hover:(border-danger text-danger)"
                        onClick={doLeave}
                        disabled={joinBusy()}
                        data-testid="leave-group"
                      >
                        Leave
                      </button>
                    </Show>
                  </div>
                </div>
              </header>

              <Show when={!isMember()}>
                <JoinCard
                  group={grp()}
                  busy={joinBusy()}
                  state={joinState()}
                  error={joinError()}
                  onJoin={doJoin}
                />
              </Show>

              {/* Tabs */}
              <div class="flex items-center gap-1 border-b border-border px-8">
                <TabButton
                  active={tab() === "channels"}
                  onClick={() => setTab("channels")}
                  testid="tab-channels"
                >
                  Channels
                </TabButton>
                <Show when={isMember() || ["public", "discoverable"].includes(grp().tier)}>
                  <TabButton
                    active={tab() === "members"}
                    onClick={() => setTab("members")}
                    testid="tab-members"
                  >
                    Members
                  </TabButton>
                </Show>
                <Show when={canManage() || canModerate()}>
                  <TabButton
                    active={tab() === "requests"}
                    onClick={() => setTab("requests")}
                    testid="tab-requests"
                  >
                    Requests
                  </TabButton>
                </Show>
                <Show when={canManage()}>
                  <TabButton
                    active={tab() === "invites"}
                    onClick={() => setTab("invites")}
                    testid="tab-invites"
                  >
                    Invites
                  </TabButton>
                </Show>
              </div>

              <div class="p-8">
                <Switch>
                  <Match when={tab() === "channels"}>
                    <section data-testid="channels-panel">
                      <div class="mb-3 flex items-center justify-between">
                        <h2 class="text-sm font-semibold tracking-tight">Channels</h2>
                        <Show when={canManage()}>
                          <button
                            type="button"
                            class="btn-accent px-3 py-1.5 text-xs"
                            onClick={() => setShowCreateChannel(true)}
                            data-testid="open-create-channel"
                          >
                            New channel
                          </button>
                        </Show>
                      </div>
                      <Show
                        when={!channels.isLoading}
                        fallback={<p class="text-sm text-muted">Loading channels…</p>}
                      >
                        <Show
                          when={(channels.data ?? []).length > 0}
                          fallback={
                            <p class="text-sm text-muted" data-testid="channels-empty">
                              No channels you can see yet.
                            </p>
                          }
                        >
                          <ul class="flex flex-col gap-1" data-testid="channels-list">
                            <For each={channels.data ?? []}>
                              {(ch) => (
                                <li
                                  class="group flex items-center gap-3 rounded-lg border border-transparent px-3 py-2 hover:(border-border bg-surface-2)"
                                  classList={{
                                    "border-border bg-surface-2": openChat()?.id === ch.id,
                                  }}
                                  data-testid="channel-row"
                                  data-channel-name={ch.name ?? ch.id}
                                >
                                  <span class="w-4 text-center text-faint">
                                    {CHANNEL_GLYPH[ch.type] ?? "#"}
                                  </span>
                                  <button
                                    type="button"
                                    class="min-w-0 flex-1 text-left disabled:cursor-default"
                                    data-testid="open-channel"
                                    disabled={ch.type !== "text"}
                                    onClick={() => ch.type === "text" && setOpenChat(ch)}
                                  >
                                    <div class="flex items-center gap-2">
                                      <span
                                        class="truncate text-sm text-ink"
                                        data-testid="channel-name-label"
                                      >
                                        {ch.name ?? ch.id}
                                      </span>
                                      <span class="badge text-[10px] uppercase">{ch.tier}</span>
                                    </div>
                                    <Show when={ch.topic}>
                                      <p class="truncate text-xs text-faint">{ch.topic}</p>
                                    </Show>
                                  </button>
                                  <Show when={canManage()}>
                                    <button
                                      type="button"
                                      class="btn-ghost px-2 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100"
                                      onClick={() => setManageChannel(ch)}
                                      data-testid="manage-channel"
                                    >
                                      Manage
                                    </button>
                                  </Show>
                                </li>
                              )}
                            </For>
                          </ul>

                          {/* Open chat for the selected text channel. */}
                          <Show when={openChat()}>
                            {(ch) => (
                              <div
                                class="mt-4 flex min-h-[28rem] flex-col overflow-hidden rounded-xl border border-border bg-surface"
                                data-testid="chat-panel"
                              >
                                <div class="flex items-center justify-end border-b border-border px-3 py-1">
                                  <button
                                    type="button"
                                    class="text-xs text-faint hover:text-ink"
                                    data-testid="close-chat"
                                    onClick={() => setOpenChat(null)}
                                  >
                                    Close chat ✕
                                  </button>
                                </div>
                                <ChatView
                                  channel={ch()}
                                  canPost={isMember() && canPost()}
                                  canPostMemo={isMember() && canPostKind(ch(), "memo")}
                                  canPostArticle={isMember() && canPostKind(ch(), "article")}
                                  canModerate={canModerate()}
                                />
                              </div>
                            )}
                          </Show>
                        </Show>
                      </Show>
                    </section>
                  </Match>
                  <Match when={tab() === "members"}>
                    <MembersPanel group={grp()} myRole={myRole} />
                  </Match>
                  <Match when={tab() === "requests"}>
                    <RequestsPanel group={grp()} enabled={() => canManage() || canModerate()} />
                  </Match>
                  <Match when={tab() === "invites"}>
                    <InvitesPanel group={grp()} enabled={canManage} />
                  </Match>
                </Switch>
              </div>

              <Show when={showCreateChannel()}>
                <CreateChannelModal
                  groupId={grp().id}
                  onClose={() => setShowCreateChannel(false)}
                />
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
            </>
          )}
        </Show>
      </Show>
    </div>
  );
};

const TabButton: Component<{
  active: boolean;
  onClick: () => void;
  children: string;
  testid: string;
}> = (props) => (
  <button
    type="button"
    class="border-b-2 px-3 py-2.5 text-sm font-medium transition-colors"
    classList={{
      "border-accent text-ink": props.active,
      "border-transparent text-muted hover:text-ink": !props.active,
    }}
    onClick={props.onClick}
    data-testid={props.testid}
  >
    {props.children}
  </button>
);

const JoinCard: Component<{
  group: Group;
  busy: boolean;
  state: "pending" | "invite-required" | null;
  error: string | null;
  onJoin: () => void;
}> = (props) => (
  <div class="mx-8 mt-6 rounded-xl border border-border bg-surface-2 p-4" data-testid="join-card">
    <Switch>
      <Match when={props.state === "pending"}>
        <p class="text-sm text-cyan" data-testid="join-pending">
          Your request to join is pending approval.
        </p>
      </Match>
      <Match when={props.state === "invite-required" || props.group.joinPolicy === "invite"}>
        <div>
          <p class="text-sm text-muted" data-testid="join-invite-required">
            This group is invite-only. Open an invite link to join.
          </p>
        </div>
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
            class="btn-accent px-4 py-1.5 text-sm"
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
