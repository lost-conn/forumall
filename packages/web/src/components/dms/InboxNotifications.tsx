/**
 * The inbox notification tabs (Mentions, Threads): the list of provider-local
 * inbound notifications of one type, its rows, and the empty-state card.
 */
import type { Notification } from "@forumall/shared";
import { useNavigate } from "@solidjs/router";
import { type Component, For, Show, createEffect, createMemo } from "solid-js";
import { formatTime } from "../../lib/time.ts";
import { markReadLocal, markSeenLocal, notificationsFor } from "../../stores/notifications.ts";
import { displayNameFor } from "../../stores/profiles.ts";
import { Icon } from "../Icon.tsx";
import { Avatar } from "../social/Avatar.tsx";
import { isRemoteActor } from "./remote-actor.ts";

/** Empty-state card for an inbox tab whose backing feed has no items yet. */
const InboxPlaceholder: Component<{ testid: string; title: string; detail: string }> = (props) => (
  <div class="px-3 py-6 text-center" data-testid={props.testid}>
    <div class="eyebrow mb-1">{props.title}</div>
    <p class="text-xs text-faint">{props.detail}</p>
  </div>
);

/** One notification row: author avatar/name, a label, time, link to the source. */
const NotificationRow: Component<{ n: Notification }> = (props) => {
  const navigate = useNavigate();
  const label = () =>
    props.n.type === "mention"
      ? "mentioned you"
      : props.n.type === "message"
        ? "posted a message"
        : "replied to you";
  const goToSource = () => {
    // Best-effort: deep-link to the channel's group (channel selection is
    // internal store state, so we land the user on the space). Mark the
    // notification READ on click-through (read implies seen).
    markReadLocal([props.n.id]);
    navigate(`/groups/${props.n.groupId}`);
  };
  return (
    <button
      type="button"
      onClick={goToSource}
      class="flex w-full gap-[11px] rounded-md border-[1.5px] border-transparent p-[11px] text-left transition-colors hover:bg-surface-2"
      classList={{ "opacity-60": !!props.n.readAt }}
      data-testid="notification-row"
      data-notification-id={props.n.id}
      data-notification-type={props.n.type}
    >
      <span class="fa-ava fa-ava--sm" classList={{ "fa-ava__fed": isRemoteActor(props.n.author) }}>
        <Avatar actor={props.n.author} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate font-body text-[13.5px] font-semibold text-ink">
            {displayNameFor(props.n.author)}
          </span>
          <span class="inline-flex items-center gap-1 font-mono text-[10px] text-faint">
            <Icon name={props.n.type === "reply" ? "reply" : "bell"} size={10} />
            {formatTime(props.n.createdAt)}
          </span>
        </span>
        <span class="mt-0.5 block truncate text-xs text-faint">{label()}</span>
      </span>
    </button>
  );
};

/**
 * The list body for a notification tab. Shows the items when present (else the
 * empty placeholder), and marks every loaded notification of this type SEEN when
 * the tab is mounted/viewed (seen = appeared in the list; read happens on
 * click-through).
 */
export const NotificationList: Component<{
  type: "mention" | "reply";
  testid: string;
  title: string;
  detail: string;
}> = (props) => {
  const items = createMemo(() => notificationsFor(props.type));
  // Mark unseen notifications of this type SEEN when the tab is viewed.
  createEffect(() => {
    const unseen = items()
      .filter((n) => !n.seenAt)
      .map((n) => n.id);
    if (unseen.length > 0) markSeenLocal(unseen);
  });
  return (
    <Show
      when={items().length > 0}
      fallback={
        <InboxPlaceholder testid={props.testid} title={props.title} detail={props.detail} />
      }
    >
      <ul
        class="flex flex-col gap-0.5"
        data-testid={`inbox-${props.type === "mention" ? "mentions" : "replies"}-list`}
      >
        <For each={items()}>{(n) => <NotificationRow n={n} />}</For>
      </ul>
    </Show>
  );
};
