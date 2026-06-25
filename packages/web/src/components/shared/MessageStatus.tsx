/**
 * MessageStatus — the optimistic-send status affordance on a message row: a
 * "sending…" label while the local echo is unconfirmed, or a "failed — retry"
 * button when delivery failed. Shared by ChatView and DmsPage, which differ only
 * in the pending-label tint (cyan vs accent) and the testid prefix.
 *
 * A message is only ever pending OR failed (never both), so at most one child
 * renders; the wrapper renders nothing when the message is settled.
 */
import { type Component, Show } from "solid-js";

export const MessageStatus: Component<{
  pending?: boolean;
  failed?: boolean;
  onRetry: () => void;
  /** Prepended to the pending/retry testids, e.g. "dm-". Default "". */
  testidPrefix?: string;
  /** Tailwind text color for the "sending…" label. Default "text-cyan". */
  pendingColor?: string;
}> = (props) => {
  const tid = (suffix: string): string => `${props.testidPrefix ?? ""}${suffix}`;
  return (
    <Show when={props.pending || props.failed}>
      <div class="flex items-center gap-2">
        <Show when={props.pending}>
          <span
            class={`text-[10px] ${props.pendingColor ?? "text-cyan"}`}
            data-testid={tid("message-pending")}
          >
            sending…
          </span>
        </Show>
        <Show when={props.failed}>
          <button
            type="button"
            class="text-[10px] text-danger underline"
            data-testid={tid("message-retry")}
            onClick={props.onRetry}
          >
            failed — retry
          </button>
        </Show>
      </div>
    </Show>
  );
};
