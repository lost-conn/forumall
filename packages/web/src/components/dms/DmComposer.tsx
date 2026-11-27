/**
 * The DM composer (§7.4): text, attachments (uploaded to the home provider for
 * the recipient's provider, §5.8), reply context and typing signals. A send is
 * delivered to the recipient's provider through {@link sendDm}.
 */
import { type Accessor, type Component, Show, createSignal } from "solid-js";
import type { DmSentStore } from "../../lib/dm-store.ts";
import { domainOf } from "../../lib/federation.ts";
import type { DmMessage } from "../../stores/dms.ts";
import { displayNameFor } from "../../stores/profiles.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { Icon } from "../Icon.tsx";
import { AttachmentChips } from "../shared/AttachmentChips.tsx";
import { ReplyContextPill } from "../shared/ReplyContextPill.tsx";
import { useComposerTyping, useComposerUpload } from "../shared/composer.ts";
import { resolveDeliveryClient } from "./dm-delivery.ts";
import { DM_UNCONFIRMED_SEND_NOTICE, DmUnconfirmedError } from "./dm-errors.ts";
import { sendDm } from "./dm-send.ts";
import {
  DM_TYPING_IDLE_MS,
  DM_TYPING_THROTTLE_MS,
  dmTypingStart,
  dmTypingStop,
} from "./dm-typing.ts";

export const DmComposer: Component<{
  dmId: string;
  counterparty: string;
  sentStore: () => DmSentStore | null;
  replyTarget: Accessor<DmMessage | null>;
  onClearReply: () => void;
  onSent: () => void;
}> = (props) => {
  const [text, setText] = createSignal("");
  // §5.8: a DM is held by the recipient's provider, so attachments are uploaded
  // (to the home provider) with that provider as their target.
  const {
    pendingAttachments,
    attachmentsForSend,
    clearAttachments,
    uploading,
    error: sendError,
    setError: setSendError,
    onPickFile,
    removeAttachment,
    setFileInput,
    openFilePicker,
  } = useComposerUpload(() => domainOf(props.counterparty) || null);
  /** A send is preparing its attachments; a second Enter must not send twice. */
  let preparing = false;

  const { notifyTyping, stopTyping } = useComposerTyping({
    start: () => {
      const ws = sessionWs();
      if (ws) dmTypingStart(ws, props.dmId);
    },
    stop: () => {
      const ws = sessionWs();
      if (ws) dmTypingStop(ws, props.dmId);
    },
    throttleMs: DM_TYPING_THROTTLE_MS,
    idleMs: DM_TYPING_IDLE_MS,
  });

  const onType = (value: string): void => {
    setText(value);
    notifyTyping();
  };

  const doSend = (): void => {
    const client = sessionClient();
    const store = props.sentStore();
    const me = session.actor;
    const body = text().trim();
    if (preparing || !client || !store || !me || !props.counterparty) return;
    if (body.length === 0 && pendingAttachments().length === 0) return;
    setSendError(null);
    // Capture the conversation now: the composer outlives a switch of
    // conversation, and the attachments may need uploading again first.
    const dmId = props.dmId;
    const counterparty = props.counterparty;
    const target = props.replyTarget();
    preparing = true;
    void attachmentsForSend()
      .finally(() => {
        preparing = false;
      })
      .then((atts) => {
        // The attachments are ready for the recipient's provider: the message
        // is now on its way, so the composer can be cleared.
        setText("");
        clearAttachments();
        props.onClearReply();
        stopTyping();
        return resolveDeliveryClient(counterparty).then((deliveryClient) =>
          sendDm({
            client,
            ...(deliveryClient ? { deliveryClient } : {}),
            dmId,
            me,
            counterparty,
            text: body,
            ...(atts.length > 0 ? { attachments: atts } : {}),
            ...(target ? { reference: { type: "reply", id: target.id } } : {}),
            sentStore: store,
          }),
        );
      })
      .then(() => props.onSent())
      .catch((err) => {
        // An unconfirmed send is NOT a failure: the echo stays pending and the
        // message may already have landed, so say "couldn't confirm" rather than
        // "couldn't send" (mirrors the edit/delete notice).
        if (err instanceof DmUnconfirmedError) {
          setSendError(DM_UNCONFIRMED_SEND_NOTICE);
          return;
        }
        setSendError(err instanceof Error ? err.message : "Could not send the message.");
      });
  };

  return (
    <div class="border-t border-border px-6 py-3" data-testid="dm-composer">
      {/* Reply context pill */}
      <Show when={props.replyTarget()}>
        {(t) => (
          <ReplyContextPill
            name={displayNameFor(t().author)}
            onCancel={() => props.onClearReply()}
            testidPrefix="dm-"
          />
        )}
      </Show>

      <AttachmentChips
        attachments={pendingAttachments()}
        onRemove={removeAttachment}
        testid="dm-composer-attachments"
      />

      <div class="flex items-center gap-2.5 rounded-md border-[1.5px] border-border-strong bg-surface px-3 py-2 focus-within:(outline outline-2 outline-accent outline-offset-1)">
        <button
          type="button"
          class="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm text-faint transition-colors hover:text-ink disabled:opacity-50"
          data-testid="dm-attach-button"
          disabled={uploading()}
          onClick={openFilePicker}
          aria-label="Attach a file"
        >
          <Icon name="plus" size={18} />
        </button>
        <input
          ref={setFileInput}
          type="file"
          class="hidden"
          data-testid="dm-file-input"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void onPickFile(file);
          }}
        />
        <textarea
          class="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          rows={1}
          data-testid="dm-composer-input"
          placeholder={`Message ${props.counterparty ? displayNameFor(props.counterparty) : "…"}…`}
          value={text()}
          onInput={(e) => onType(e.currentTarget.value)}
          onBlur={stopTyping}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              doSend();
            }
          }}
        />
        <button
          type="button"
          class="btn-accent shrink-0 px-4 py-2 text-xs"
          data-testid="dm-send-button"
          onClick={doSend}
        >
          <Icon name="send" size={14} />
          Send
        </button>
      </div>
      <Show when={sendError()}>
        <p class="mt-1 text-xs text-danger" data-testid="dm-composer-error">
          {sendError()}
        </p>
      </Show>
    </div>
  );
};
