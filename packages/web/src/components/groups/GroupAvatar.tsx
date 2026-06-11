/**
 * GroupAvatar (Overboard "Group avatars") — a group's avatar image when one is
 * set, falling back to the initial of the group name otherwise.
 *
 * Unlike the user {@link Avatar} (which is keyed on a global actor and reads the
 * `avatarFor` profile cache), a group's avatar lives on the `Group` object
 * itself (`Group.avatar`), so this component takes the URL directly. The URL is
 * resolved through {@link resolveAttachmentUrl} (provider-hosted media) and an
 * `onError` flips back to initials so the slot never shows a broken-image glyph.
 *
 * The caller controls size/shape via `class` (merged onto the round slot).
 */
import { type Component, Show, createEffect, createSignal } from "solid-js";
import { resolveAttachmentUrl } from "../../lib/chat-api.ts";

export const GroupAvatar: Component<{
  /** Group display name — first letter is the initials fallback. */
  name: string;
  /** Group avatar URL (`Group.avatar`), if any. */
  avatar?: string;
  /** Extra classes for the round slot (sizing/text-size). */
  class?: string;
}> = (props) => {
  const [failed, setFailed] = createSignal(false);
  const src = () => {
    const url = props.avatar?.trim();
    return url ? resolveAttachmentUrl(url) : undefined;
  };
  // Reset the failure flag whenever the resolved URL changes.
  createEffect(() => {
    src();
    setFailed(false);
  });
  const initials = () => (props.name || "?").slice(0, 1).toUpperCase();

  return (
    <span
      class={`grid shrink-0 place-items-center overflow-hidden rounded-md bg-surface-2 font-display font-bold text-faint ${props.class ?? "h-9 w-9 text-sm"}`}
      data-testid="group-avatar"
    >
      <Show when={src() && !failed()} fallback={initials()}>
        <img
          src={src()}
          alt=""
          class="h-full w-full object-cover"
          data-testid="group-avatar-image"
          onError={() => setFailed(true)}
        />
      </Show>
    </span>
  );
};
