/**
 * Federation allow/deny policy (spec §8 "Authorization").
 *
 * §8 requires providers to "apply allow/deny policy for which remote providers
 * may federate". This module is the single decision point for whether a remote
 * peer domain is permitted to federate with this provider. It is consulted by
 * the signature middleware for **remote** signers (both user-signed remote
 * actors and provider-signed remote providers) *before* any network resolution,
 * and is reused by the WS connect-time enforcement card.
 *
 * ## Policy semantics (deny wins)
 *  - **Deny-list** (`FEDERATION_DENY`): if `domain` is on it → denied, always.
 *  - **Allow-list** (`FEDERATION_ALLOW`): if non-empty, only listed domains are
 *    allowed (everything else denied). If empty, all non-denied domains pass.
 *  - **Default (both empty)**: open — every domain is allowed, none denied.
 *
 * Deny takes precedence over allow, so a domain present on both lists is denied.
 *
 * Domains are compared after {@link canonicalAuthority} normalization (lower-
 * cased, default-port-stripped) so `A.TEST`, `a.test`, and `a.test:443` all
 * match a single list entry.
 *
 * Local actors never reach this check — it is only applied to remote peers.
 */
import { canonicalAuthority } from "@forumall/shared";

import type { Config } from "../../config.ts";

/**
 * Decide whether a remote provider/actor `domain` is allowed to federate with
 * this provider, per `config.federationAllow` / `config.federationDeny`.
 *
 * @returns `true` if the domain may federate, `false` if it is denied.
 */
export function isProviderAllowed(config: Config, domain: string): boolean {
  const host = canonicalAuthority(domain);

  // Deny wins: an explicit deny-list entry blocks the domain unconditionally.
  if (config.federationDeny.includes(host)) return false;

  // Allow-list set → only listed domains are permitted; everything else denied.
  if (config.federationAllow.length > 0) {
    return config.federationAllow.includes(host);
  }

  // No allow-list → default open (all non-denied domains permitted).
  return true;
}
