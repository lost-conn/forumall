/**
 * Toggle — a dashed-divider settings row with a label, optional detail subtext,
 * and an fa-switch on the right. Previously hand-rolled as `ToggleRow`
 * (NotificationSettings) and `SettingRow` (ArticleEditorOverlay). `detail` and
 * `disabled` are optional so it covers both; `last:border-b-0` drops the
 * trailing divider when several stack in a list.
 */
import { type Component, Show } from "solid-js";

export const Toggle: Component<{
  label: string;
  checked: boolean;
  onToggle: (on: boolean) => void;
  detail?: string;
  disabled?: boolean;
  testid?: string;
}> = (props) => (
  <div class="flex items-center gap-3 border-b border-dashed border-border py-3 last:border-b-0">
    <div class="flex-1">
      <div class="font-body text-[13.5px] text-ink">{props.label}</div>
      <Show when={props.detail}>
        <div class="fa-meta mt-[3px]">{props.detail}</div>
      </Show>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      data-testid={props.testid}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => !props.disabled && props.onToggle(!props.checked)}
      class="fa-switch"
      classList={{
        "fa-switch--on": props.checked,
        "opacity-50 cursor-not-allowed": props.disabled,
      }}
    >
      <span class="fa-switch__knob" />
    </button>
  </div>
);
