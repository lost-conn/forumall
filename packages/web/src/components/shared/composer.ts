/**
 * Shared composer logic for the channel chat composer (ChatComposer) and the DM
 * composer (DmComposer). Both hand-rolled byte-identical attachment-upload state
 * and near-identical typing throttle/idle bookkeeping; these primitives own that
 * logic so the two composers can't drift (the original cause of the DM composer
 * alignment bug was exactly this kind of copy-paste divergence).
 */
import type { Attachment } from "@forumall/shared";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { uploadMedia } from "../../lib/chat-api.ts";
import {
  type PendingUpload,
  type Uploader,
  retargetUploads,
  uploadFor,
} from "../../lib/pending-uploads.ts";
import { sessionClient } from "../../stores/session.ts";

/**
 * Attachment-upload + send-error state for a composer. Owns the pending
 * attachments, the in-flight `uploading` flag, and the shared error signal
 * (used for both upload and send failures). `setFileInput` is a ref callback for
 * the hidden file input; `openFilePicker` opens it.
 *
 * `target` names the provider that will hold the message being composed (its
 * canonical authority, §5.8), or `null` while unknown. Each upload is made for
 * the target current when the file was picked; {@link attachmentsForSend}
 * re-uploads any that were made for another provider (a DM composer kept
 * across a switch of conversation) before the message goes out.
 */
export function useComposerUpload(target: () => string | null) {
  const [pending, setPending] = createSignal<readonly PendingUpload[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let fileInput: HTMLInputElement | undefined;
  const pendingAttachments = createMemo<Attachment[]>(() => pending().map((p) => p.attachment));

  /** The home-provider uploader, or null without a signed-in session. */
  const uploader = (): Uploader | null => {
    const client = sessionClient();
    return client ? (file, to) => uploadMedia(client, file, { target: to }) : null;
  };

  const onPickFile = async (file: File): Promise<void> => {
    const upload = uploader();
    const to = target();
    if (!upload || !to) return;
    setUploading(true);
    setError(null);
    try {
      const entry = await uploadFor(file, to, upload);
      setPending((prev) => [...prev, entry]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInput) fileInput.value = "";
    }
  };

  /**
   * The pending attachments, each usable in a message held by the current
   * target: uploads made for another provider are uploaded again first (§5.8).
   * Rejects (with `uploading` reset) if the target is unknown or an upload fails.
   */
  const attachmentsForSend = async (): Promise<Attachment[]> => {
    const current = pending();
    const to = target();
    const upload = uploader();
    if (current.length === 0) return [];
    if (!to || !upload) throw new Error("Cannot attach files to this message.");
    setUploading(true);
    try {
      const ready = await retargetUploads(current, to, upload);
      setPending(ready);
      return ready.map((p) => p.attachment);
    } finally {
      setUploading(false);
    }
  };

  return {
    pendingAttachments,
    attachmentsForSend,
    uploading,
    error,
    setError,
    onPickFile,
    removeAttachment: (index: number) => setPending((prev) => prev.filter((_, i) => i !== index)),
    clearAttachments: () => setPending([]),
    setFileInput: (el: HTMLInputElement) => {
      fileInput = el;
    },
    openFilePicker: () => fileInput?.click(),
  };
}

/**
 * Typing-indicator throttle/idle bookkeeping. `start`/`stop` emit the
 * transport-specific typing signals (channel vs DM); `notifyTyping()` is called
 * on each keystroke and re-emits `start` at most once per `throttleMs`, then
 * fires `stop` after `idleMs` of silence. The idle timer is cleared on unmount.
 */
export function useComposerTyping(opts: {
  start: () => void;
  stop: () => void;
  throttleMs: number;
  idleMs: number;
}) {
  let lastStart = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopTyping = (): void => {
    opts.stop();
    lastStart = 0;
    if (idleTimer) clearTimeout(idleTimer);
  };

  const notifyTyping = (): void => {
    const now = Date.now();
    if (now - lastStart > opts.throttleMs) {
      opts.start();
      lastStart = now;
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stopTyping, opts.idleMs);
  };

  onCleanup(() => {
    if (idleTimer) clearTimeout(idleTimer);
  });

  return { notifyTyping, stopTyping };
}
