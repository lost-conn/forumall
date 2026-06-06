/**
 * User-profile modal store (P-overboard, §5.1/§6/§7.5). A single global signal
 * holding the actor whose profile card is open (or null). Any view — a chat
 * author, a contact row, a DM header, a member list — calls
 * {@link openUserProfile} to surface the card, which is mounted once at the app
 * root ({@link UserProfileCard}).
 */
import { createSignal } from "solid-js";

const [profileActor, setProfileActor] = createSignal<string | null>(null);

export { profileActor };

/** Open the profile card for `actor` (`handle@domain`). */
export function openUserProfile(actor: string): void {
  if (actor && actor.length > 0) setProfileActor(actor);
}

/** Close the profile card. */
export function closeUserProfile(): void {
  setProfileActor(null);
}
