/**
 * The profile settings form's save payload (§6.3 `PATCH /api/me/profile`), as a
 * pure function so it can be tested without a DOM.
 */

/** What the user typed into the profile form. */
export interface ProfileFormFields {
  readonly displayName: string;
  readonly avatar: string;
  readonly bio: string;
}

/** The `PATCH /api/me/profile` body the form sends. */
export interface ProfileUpdateBody {
  displayName: string;
  bio: string;
  avatar?: string | null;
}

/**
 * Build the update body from the form, or a user-facing error.
 *
 * `avatar` is sent only when it differs from `storedAvatar` (the avatar the
 * profile was loaded with, or last saved): the server checks a new avatar URL
 * is media it hosts, so re-sending an unchanged older avatar — say an external
 * URL set before that check — would make an unrelated edit (a bio) fail. An
 * emptied field is sent as `null` (remove the avatar), never as `""`; a
 * non-https URL is caught here with a clear message.
 */
export function profileUpdateBody(
  fields: ProfileFormFields,
  storedAvatar: string | null,
): { body: ProfileUpdateBody } | { error: string } {
  const body: ProfileUpdateBody = {
    displayName: fields.displayName.trim(),
    bio: fields.bio.trim(),
  };
  const avatar = fields.avatar.trim() || null;
  if (avatar === (storedAvatar || null)) return { body };
  if (avatar !== null && !/^https:\/\//.test(avatar)) {
    return { error: "Avatar must be an https:// URL." };
  }
  body.avatar = avatar;
  return { body };
}
