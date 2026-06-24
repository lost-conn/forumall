/**
 * EditMessageForm — the inline "edit this message" affordance shared by the
 * channel chat row (ChatView) and the DM thread row (DmsPage). Both rendered an
 * identical textarea + Save/Cancel + error block; the only differences were a
 * `w-full` on the DM variant and the `dm-` testid prefix.
 *
 * Enter (without Shift) submits; Escape cancels — matching the composer.
 */
import { type Component, Show } from "solid-js";

export const EditMessageForm: Component<{
  value: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  error?: string | null;
  /** Prepended to the input/save/error testids, e.g. "dm-". Default "". */
  testidPrefix?: string;
  /** DM rows render the editor full-width; the channel row does not. */
  fullWidth?: boolean;
}> = (props) => {
  const tid = (suffix: string): string => `${props.testidPrefix ?? ""}${suffix}`;
  return (
    <div class="flex flex-col gap-1" classList={{ "w-full": props.fullWidth }}>
      <textarea
        class="input min-h-16 resize-y"
        data-testid={tid("edit-input")}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit();
          }
          if (e.key === "Escape") props.onCancel();
        }}
      />
      <div class="flex gap-2">
        <button
          type="button"
          class="btn-accent px-3 py-1 text-xs"
          data-testid={tid("save-edit")}
          onClick={props.onSubmit}
        >
          Save
        </button>
        <button type="button" class="btn-ghost px-3 py-1 text-xs" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      <Show when={props.error}>
        <p class="text-xs text-danger" data-testid={tid("edit-error")}>
          {props.error}
        </p>
      </Show>
    </div>
  );
};
