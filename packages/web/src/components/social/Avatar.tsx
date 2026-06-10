/**
 * Avatar (Overboard "Profile photo upload") — the shared inner content of an
 * avatar slot: a user's profile photo when one is cached, falling back to text
 * initials otherwise.
 *
 * GLOBAL, not per-group: avatars come from {@link avatarFor} keyed by the full
 * actor (`handle@domain`), populated by the same `warmProfile(s)` calls the
 * display-name cache already makes. Reading `avatarFor` here subscribes the
 * component, so a photo swaps in live once the profile resolves.
 *
 * This renders ONLY the inner content (an `<img>` or an initials node) and is
 * meant to live inside an existing styled slot (e.g. a `.fa-ava` button/span or
 * a `rounded-full` span) — keeping each call site's container, sizing, click
 * handler, and federation decoration intact. The slot's `overflow: hidden` +
 * border-radius clips the image to the avatar shape; the `<img>` fills the slot.
 *
 * If the image URL fails to load (broken/blocked URL), `onError` flips back to
 * the initials so the slot never shows a broken-image glyph.
 */
import { type Component, Show, createEffect, createSignal } from "solid-js";
import { resolveAttachmentUrl } from "../../lib/chat-api.ts";
import { avatarFor } from "../../stores/profiles.ts";

export const Avatar: Component<{
  /** Full actor (`handle@domain`) whose cached avatar we render. */
  actor: string;
  /** Pre-computed initials/letter to show when there's no usable photo. */
  initials: string;
}> = (props) => {
  // Reset the load-failure flag whenever the resolved URL changes, so a later
  // valid avatar (e.g. the user fixes a broken URL) gets a fresh chance to load.
  const [failed, setFailed] = createSignal(false);
  const src = () => {
    const url = avatarFor(props.actor);
    return url ? resolveAttachmentUrl(url) : undefined;
  };
  createEffect(() => {
    src();
    setFailed(false);
  });

  return (
    <Show when={src() && !failed()} fallback={props.initials}>
      <img
        src={src()}
        alt=""
        class="h-full w-full object-cover"
        data-testid="avatar-image"
        onError={() => setFailed(true)}
      />
    </Show>
  );
};
