/**
 * Shared composer logic for the channel chat composer (ChatView) and the DM
 * composer (DmsPage). Both hand-rolled byte-identical attachment-upload state
 * and near-identical typing throttle/idle bookkeeping; these primitives own that
 * logic so the two composers can't drift (the original cause of the DM composer
 * alignment bug was exactly this kind of copy-paste divergence).
 */
import type { Attachment } from "@forumall/shared";
import { createSignal, onCleanup } from "solid-js";
import { uploadMedia } from "../../lib/chat-api.ts";
import { sessionClient } from "../../stores/session.ts";

/**
 * Attachment-upload + send-error state for a composer. Owns the pending
 * attachments, the in-flight `uploading` flag, and the shared error signal
 * (used for both upload and send failures). `setFileInput` is a ref callback for
 * the hidden file input; `openFilePicker` opens it.
 */
export function useComposerUpload() {
  const [pendingAttachments, setPendingAttachments] = createSignal<Attachment[]>([]);
  const [uploading, setUploading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let fileInput: HTMLInputElement | undefined;

  const onPickFile = async (file: File): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setUploading(true);
    setError(null);
    try {
      const att = await uploadMedia(client, file);
      setPendingAttachments((prev) => [...prev, att]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInput) fileInput.value = "";
    }
  };

  return {
    pendingAttachments,
    setPendingAttachments,
    uploading,
    error,
    setError,
    onPickFile,
    removeAttachment: (index: number) =>
      setPendingAttachments((prev) => prev.filter((_, i) => i !== index)),
    clearAttachments: () => setPendingAttachments([]),
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
