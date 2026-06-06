/**
 * Social API surface (P8, spec §6 + §7.5): presence, privacy, profile, contacts.
 *
 * Thin typed wrappers over the authenticated {@link OfscpClient} from the session
 * store, mirroring `groups-api.ts`. Every call goes through the session's signing
 * client so requests carry the §4.4 signature the server's §4.5 middleware
 * accepts. Functions return parsed bodies and throw `OfscpHttpError` on non-2xx,
 * so the screens + stores stay terse and the server stays authoritative.
 */
import type {
  Contact,
  ContactsResponse,
  Presence,
  PrivacySettings,
  PrivacySettingsUpdateRequest,
  UserPublicProfileResponse,
} from "@forumall/shared";
import type { OfscpClient } from "./ofscp-client.ts";

/** Encode an actor `handle@domain` for a `{userRef}` path segment (the `@`). */
export function encodeUserRef(actor: string): string {
  return encodeURIComponent(actor);
}

// ---------------------------------------------------------------------------
// Presence (§6.4 / §7.5 REST surface)
// ---------------------------------------------------------------------------

/** Read a subject's presence, filtered for the caller exactly as the WS fan-out. */
export async function fetchPresence(client: OfscpClient, ref: string): Promise<Presence> {
  const res = await client.get<Presence>(`/api/users/${encodeUserRef(ref)}/presence`);
  return res.data;
}

/** Settable availability (the WS/REST set surface rejects `offline`). */
export type SettableAvailability = "online" | "away" | "dnd";

/**
 * Set the caller's own availability + status (`PUT /api/me/presence`, equivalent
 * to the WS `presence.set`). The WS command is preferred when a connection is up
 * (it fans out immediately); this REST form is the durable fallback.
 */
export async function setMyPresence(
  client: OfscpClient,
  body: { availability: SettableAvailability; status?: string },
): Promise<Presence> {
  const res = await client.put<Presence>("/api/me/presence", {
    availability: body.availability,
    ...(body.status !== undefined ? { status: body.status } : {}),
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// Privacy + profile (§6.3 / §6.6)
// ---------------------------------------------------------------------------

/** Read the caller's privacy settings. */
export async function fetchPrivacy(client: OfscpClient): Promise<PrivacySettings> {
  const res = await client.get<PrivacySettings>("/api/me/privacy");
  return res.data;
}

/** The privacy-update body, including the passthrough allow/deny lists (§6.6). */
export type PrivacyUpdate = PrivacySettingsUpdateRequest & {
  allowList?: string[];
  denyList?: string[];
};

/** Update the caller's privacy settings (`PUT /api/me/privacy`). */
export async function updatePrivacy(
  client: OfscpClient,
  body: PrivacyUpdate,
): Promise<PrivacySettings> {
  const res = await client.put<PrivacySettings>("/api/me/privacy", body);
  return res.data;
}

/** Update the caller's profile (`PATCH /api/me/profile`, §6.3). */
export async function updateProfile(
  client: OfscpClient,
  body: { displayName?: string; avatar?: string; bio?: string },
): Promise<UserPublicProfileResponse> {
  const res = await client.patch<UserPublicProfileResponse>("/api/me/profile", body);
  return res.data;
}

/** Read another user's public profile (`bio` gated by their profileVisibility). */
export async function fetchProfile(
  client: OfscpClient,
  ref: string,
): Promise<UserPublicProfileResponse> {
  const res = await client.get<UserPublicProfileResponse>(
    `/api/users/${encodeUserRef(ref)}/profile`,
  );
  return res.data;
}

// ---------------------------------------------------------------------------
// Contacts (§6.7)
// ---------------------------------------------------------------------------

/** List the caller's contacts (accepted + pending in both directions). */
export async function fetchContacts(client: OfscpClient): Promise<Contact[]> {
  const res = await client.get<ContactsResponse>("/api/me/contacts");
  return res.data.contacts ?? [];
}

/** Send a contact request to `user` (an actor `handle@domain`). */
export async function requestContact(client: OfscpClient, user: string): Promise<Contact> {
  const res = await client.post<Contact>("/api/me/contacts", { user });
  return res.data;
}

/** Accept an incoming pending request from `user`. */
export async function acceptContact(client: OfscpClient, user: string): Promise<Contact> {
  const res = await client.post<Contact>(`/api/me/contacts/${encodeUserRef(user)}/accept`, {});
  return res.data;
}

/**
 * Remove the caller's contact row for `user` — cancels an outgoing request,
 * declines an incoming one, or removes an established contact (§6.7, `DELETE`).
 */
export async function removeContact(client: OfscpClient, user: string): Promise<void> {
  await client.delete(`/api/me/contacts/${encodeUserRef(user)}`);
}
