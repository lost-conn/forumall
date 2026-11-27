/**
 * Registration modes and account invites (OFSCP §4.1.1), for the sign-up form
 * and the guest claim form (§4.8.1, which follows the same mode).
 *
 *  - A provider advertises who may register as discovery
 *    `provider.authentication.registration`: `"open"` (also when absent, or a
 *    value this client does not know), `"invite"` or `"closed"`.
 *  - An invite-only provider needs an `inviteToken` in the request; it shares
 *    one as a link `https://{authority}/register?invite={token}`.
 *  - The mode can change, so a client handles the errors whatever it read:
 *    `403 registration_closed` and `403 invite_required` (one code for a
 *    missing, unknown, expired, spent or handle-pinned token).
 */
import { canonicalAuthority } from "@forumall/shared";
import { OfscpHttpError } from "./ofscp-client.ts";

/** Who may create accounts on a provider (§4.1.1). */
export type RegistrationMode = "open" | "invite" | "closed";

/**
 * The registration mode a discovery document advertises. Absent means
 * `"open"`, and so does a value this client does not recognise (§4.1.1
 * "Unknown modes": rely on the errors instead).
 */
export function registrationModeOf(discovery: unknown): RegistrationMode {
  const value = (discovery as { provider?: { authentication?: { registration?: unknown } } } | null)
    ?.provider?.authentication?.registration;
  return value === "invite" || value === "closed" ? value : "open";
}

/** The two registration-mode refusals (§7.3 registry codes, both `403`). */
export type RegistrationRefusal = "registration_closed" | "invite_required";

/** The registration-mode refusal `err` carries, if it is one. */
export function registrationRefusalOf(err: unknown): RegistrationRefusal | null {
  if (!(err instanceof OfscpHttpError) || err.status !== 403) return null;
  const code = (err.body as { errorCode?: unknown } | null | undefined)?.errorCode;
  return code === "registration_closed" || code === "invite_required" ? code : null;
}

/**
 * The user-facing explanation of a registration-mode refusal, or `null` when
 * `err` is not one. `sentInvite` says whether the request carried a token:
 * `invite_required` then means the token is not usable (the provider does not
 * say why, by design), otherwise that one is needed.
 */
export function registrationRefusalMessage(
  err: unknown,
  opts: { sentInvite: boolean; claiming?: boolean },
): string | null {
  const refusal = registrationRefusalOf(err);
  if (refusal === null) return null;
  if (refusal === "registration_closed") {
    return opts.claiming
      ? "This provider isn't accepting new accounts, so a guest account can't be made permanent here. You can still merge it into an account you already have."
      : "This provider isn't accepting new accounts. Sign in if you already have one, or choose another provider.";
  }
  return opts.sentInvite
    ? "That invite token can't be used: it may be mistyped, expired, already used, or meant for a different handle."
    : "This provider is invite-only. Enter the invite token you were given.";
}

/** An account invite read from an invite link. */
export interface InviteLink {
  /** Canonical authority of the provider the link names (§2.2). */
  authority: string;
  token: string;
}

/**
 * Read an account invite from a page URL of the form
 * `https://{authority}/register?invite={token}` (§4.1.1), or `null` if the URL
 * is not one. The authority is returned so the UI can show the user which
 * provider the link is for before any password is entered.
 */
export function inviteLinkFrom(url: URL): InviteLink | null {
  if (url.pathname !== "/register") return null;
  const token = url.searchParams.get("invite")?.trim();
  if (!token) return null;
  return { authority: canonicalAuthority(url.host), token };
}

/** The parts of `window` {@link takePageInvite} reads and rewrites. */
export interface PageLocation {
  location: { href: string };
  history: { state: unknown; replaceState(data: unknown, unused: string, url: string): void };
}

/**
 * Read the account invite from the page's invite link (§4.1.1) and remove the
 * `invite` parameter from the address bar with `history.replaceState`: tokens
 * in links leak (history, bookmarks, a shared screen, a copied URL), so once
 * the page holds the token the URL stops carrying it. The rest of the URL (path,
 * other parameters, hash) and the history entry's state are kept.
 *
 * Read it ONCE per page load and keep the result: after this call the URL no
 * longer names the token.
 */
export function takePageInvite(page: PageLocation): InviteLink | null {
  const url = new URL(page.location.href);
  if (url.pathname !== "/register" || !url.searchParams.has("invite")) return null;
  const link = inviteLinkFrom(url);
  url.searchParams.delete("invite");
  page.history.replaceState(page.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return link;
}
