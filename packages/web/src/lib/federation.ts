/**
 * Client-side federation helpers (P9, spec §4.6 / §6.7 / §7.4 / §8.x).
 *
 * Every cross-provider request the client makes is signed with the user's HOME
 * device key + HOME actor, but addressed (and signed) for the REMOTE provider's
 * authority. The remote provider resolves the signer's published key from the
 * actor's home provider via §4.6 — reachable in a loopback dev/test topology only
 * because the receiving provider runs the insecure-localhost federation transport
 * (`FEDERATION_INSECURE_LOCALHOST`, server-side). This module is the single place
 * that builds a per-host signing {@link OfscpClient} for the home identity, so the
 * DM / contacts cards don't each re-derive the transport + authority.
 *
 * Identity vs. authority: the `OfscpClient` signs with `authority = targetHost`
 * (what the remote verifier binds as `config.domain`) while keeping the home
 * `actor`/`keyId`/`privateKey` — exactly the §4.4.2 shape a remote provider
 * verifies after resolving the home key (§4.5 step 6 → §4.6).
 */
import { canonicalAuthority } from "@forumall/shared";
import { OfscpClient } from "./ofscp-client.ts";
import { baseUrlForHost } from "./provider.ts";

/** The host (domain) part of an actor `handle@domain`, canonicalized. */
export function domainOf(actor: string): string {
  const at = actor.lastIndexOf("@");
  if (at <= 0 || at === actor.length - 1) return "";
  return canonicalAuthority(actor.slice(at + 1));
}

/** True when `actor` is homed on `homeHost` (same canonical authority). */
export function isLocalActor(actor: string, homeHost: string): boolean {
  const d = domainOf(actor);
  return d !== "" && d === canonicalAuthority(homeHost);
}

/** The home identity that signs every cross-provider request. */
export interface HomeIdentity {
  /** Home actor `handle@homeHost`. */
  readonly actor: string;
  /** Active home device key id. */
  readonly keyId: string;
  /** Base64 Ed25519 private seed for `keyId` (from the key-store). */
  readonly privateKey: string;
}

/**
 * Build a signing {@link OfscpClient} targeting `host`, signed by the home
 * identity with `authority = host`. When `host` is the home host this is just the
 * normal home transport; for a remote host the request is delivered to that
 * provider over its own transport and verified against the home key via §4.6.
 */
export function clientForHost(host: string, id: HomeIdentity): OfscpClient {
  return new OfscpClient({
    baseUrl: baseUrlForHost(host),
    authority: canonicalAuthority(host),
    actor: id.actor,
    keyId: id.keyId,
    privateKey: id.privateKey,
  });
}
