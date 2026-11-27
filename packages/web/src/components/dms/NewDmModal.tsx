/**
 * The new-DM modal: pick a counterparty (`handle@domain`) and start a
 * conversation with them.
 */
import { canonicalActor } from "@forumall/shared";
import { type Component, Show, createSignal, onMount } from "solid-js";
import { session } from "../../stores/session.ts";
import { Modal } from "../shared/Modal.tsx";

// ---------------------------------------------------------------------------
// New-DM modal
// ---------------------------------------------------------------------------

export const NewDmModal: Component<{
  onClose: () => void;
  onStart: (counterparty: string) => void;
}> = (props) => {
  const [recipient, setRecipient] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  let inputEl: HTMLInputElement | undefined;
  onMount(() => inputEl?.focus());

  const submit = (): void => {
    // Senders MUST send actors in canonical form (§2.2): `Bob@host:443` → `bob@host`.
    const raw = recipient().trim();
    const value = canonicalActor(raw) ?? raw.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(value)) {
      setError("Enter a recipient as handle@domain.");
      return;
    }
    if (value === session.actor) {
      setError("You can't DM yourself.");
      return;
    }
    props.onStart(value);
  };

  return (
    <Modal onClose={props.onClose} size="sm" testid="new-dm-modal">
      <h2 class="mb-1 text-sm font-semibold tracking-tight">New direct message</h2>
      <p class="mb-4 text-xs text-muted">Enter a recipient's actor to start a conversation.</p>
      <label class="mb-1 block text-xs text-muted" for="new-dm-recipient">
        Recipient
      </label>
      <input
        ref={inputEl}
        id="new-dm-recipient"
        class="input"
        data-testid="new-dm-recipient"
        placeholder="handle@domain"
        value={recipient()}
        onInput={(e) => {
          setRecipient(e.currentTarget.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") props.onClose();
        }}
      />
      <Show when={error()}>
        <p class="mt-1 text-xs text-danger" data-testid="new-dm-error">
          {error()}
        </p>
      </Show>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-ghost px-3 py-1.5 text-xs" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          class="btn-accent px-3 py-1.5 text-xs"
          data-testid="new-dm-start"
          onClick={submit}
        >
          Start chat
        </button>
      </div>
    </Modal>
  );
};
