/**
 * Canonical-form checks for identifiers read from request bodies (OFSCP §2.2).
 *
 * §2.2 lets a receiver either reject a non-canonical spelling or convert it
 * before use. Forumall **rejects** (`400`) for every actor it reads from a
 * request body (`with`, `to`, `user`, `from`, privacy `allowList`/`denyList`, a
 * provider-signed acting `actor`, …) and for every provider authority named by
 * a URI it will store or contact (a follow's `channel` object URI, a webhook
 * `target`, a push `endpoint`): the client always has the canonical form to
 * hand, and rejecting means no handler can forget to convert before a
 * comparison, `dmId` derivation, allow/deny decision, stored row or outbound
 * request. Two spellings of one actor/provider are never two.
 */
import { isCanonicalActor, isCanonicalAuthority } from "@forumall/shared";

import { AppError } from "./errors.ts";

/** Throw `400` unless `value` is a canonical actor (`handle@domain`, §2.2). */
export function assertCanonicalActorField(value: string, field: string): void {
  if (!isCanonicalActor(value)) {
    throw AppError.badRequest({
      detail: `\`${field}\` must be a canonical actor (handle@domain, OFSCP §2.2)`,
    });
  }
}

/**
 * The authority of absolute URI `uri` exactly as written (not normalized by a
 * URL parser, which would hide e.g. a trailing dot), or `null` if `uri` is not
 * `scheme://authority…`.
 */
function rawUriAuthority(uri: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(uri);
  return m ? (m[1] as string) : null;
}

/**
 * Throw `400` unless the authority of `uri` is a canonical provider authority
 * (§2.2: lowercase, no `:443`, no trailing dot, `xn--` IDNs, no userinfo), and
 * return it — ready for the §8 allow/deny check.
 */
export function assertCanonicalUriAuthority(uri: string, field: string): string {
  const authority = rawUriAuthority(uri);
  if (authority === null || authority.includes("@") || !isCanonicalAuthority(authority)) {
    throw AppError.badRequest({
      detail: `\`${field}\` must name its provider in canonical form (OFSCP §2.2)`,
    });
  }
  return authority;
}
