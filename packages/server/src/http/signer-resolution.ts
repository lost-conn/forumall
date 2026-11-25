/**
 * Signer resolution for §4.5 step 6 (spec §4.6, §8.1): find the public key a
 * signed request must verify against, and — when there is none — say WHY,
 * because the answer depends on it.
 *
 * | Outcome          | Meaning                                                        | Status |
 * |------------------|----------------------------------------------------------------|--------|
 * | `no_key`         | a completed fetch (or local lookup) has no such active key     | `401`  |
 * | `bad_signature`  | the key resolved but the signature does not verify against it  | `401`  |
 * | `refused`        | the outbound-request rules (§8) forbid fetching the keys       | `401`  |
 * | `fetch_failed`   | the keys could not be fetched (network/DNS/timeout/non-200/…)  | `503`  |
 *
 * Federation-policy denial (`403`, §8 Authorization) is decided by the
 * verifier from the claimed domain BEFORE anything here runs, so a denied
 * peer is never fetched ({@link remotePeerDomain}).
 *
 * ## Remote signers verify during resolution
 * §4.6/§8.1 require a re-fetch "before finally rejecting" when a key that is
 * believed valid fails verification, so remote paths verify here: a key served
 * from the cache that fails verification forces ONE re-fetch; a key that was
 * just fetched is not fetched again. The cache itself re-fetches when the
 * requested `key_id` is absent from an unexpired entry. So one inbound request
 * causes at most one key fetch, and therefore waits at most one egress
 * deadline (`DEFAULT_EGRESS_TIMEOUT_MS`).
 *
 * ## Identity shape (security-critical)
 * Only the LOCAL actor branch sets `localHandle` — the bare handle is a key
 * into this provider's own tables, and a remote signer's handle lives in a
 * different namespace (it may collide with a local user's). See the identity
 * rule on {@link AuthenticatedActor}.
 */
import { canonicalAuthority, verify } from "@forumall/shared";

import type { Db } from "../db/index.ts";
import { resolveActorKeys } from "../provider/device-keys.ts";
import type { RemoteDiscoveryCache } from "../provider/federation/discovery-cache.ts";
import type { KeyLookup } from "../provider/federation/key-lookup.ts";
import type { RemoteUserKeysCache } from "../provider/federation/user-keys-cache.ts";
import { getProviderSigningKeyById } from "../provider/signing-key.ts";
import { AppError } from "./errors.ts";
import type { AuthenticatedActor, SignatureMode } from "./types.ts";

/**
 * `Retry-After` (seconds) sent with a `503` when a signer's keys could not be
 * fetched. Long enough for a transient DNS/peer outage to clear, short enough
 * that a background sender (`BACKGROUND_RETRY`) retries within its budget.
 */
export const KEY_FETCH_RETRY_AFTER_SECONDS = 30;

/** The selected verification key + the actor/provider identity it belongs to. */
export interface ResolvedSigner {
  /** Base64 raw 32-byte Ed25519 public key to verify against. */
  readonly publicKey: string;
  /** Authenticated identity to expose on `c.var.actor`. */
  readonly actor: AuthenticatedActor;
  /**
   * Set by resolvers that verify internally (the remote paths, so they can
   * re-fetch on a miss). When true the pipeline trusts that result and skips
   * the generic step-7 verify; when false/absent step 7 performs the check.
   */
  readonly verified?: boolean;
}

/** The §4.4.2 inputs a resolver needs to (re)verify a candidate key. */
export interface VerifyTarget {
  readonly authority: string;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly contentDigest: string;
  readonly signature: string;
}

/** Why no signer resolved (see the module table). */
export type SignerFailure = "no_key" | "bad_signature" | "refused" | "fetch_failed";

/** A resolved signer, or the reason there is none. */
export type SignerResolution =
  | { readonly ok: true; readonly signer: ResolvedSigner }
  | { readonly ok: false; readonly failure: SignerFailure; readonly reason?: string };

/** Resolve the signer for `mode` (user device key §4.6, or provider key §8.1). */
export function resolveSigner(
  mode: SignatureMode,
  args: {
    readonly db: Db;
    /** This provider's canonical authority. */
    readonly domainHost: string;
    /** The (canonical) `X-OFSCP-Actor` / `X-OFSCP-Provider` value. */
    readonly identity: string;
    readonly keyId: string;
    readonly userKeysCache: RemoteUserKeysCache;
    readonly discoveryCache: RemoteDiscoveryCache;
    readonly target: VerifyTarget;
  },
): Promise<SignerResolution> {
  return mode === "provider"
    ? resolveProviderSigner(
        args.db,
        args.domainHost,
        args.identity,
        args.keyId,
        args.discoveryCache,
        args.target,
      )
    : resolveActorSigner(
        args.db,
        args.domainHost,
        args.identity,
        args.keyId,
        args.userKeysCache,
        args.target,
      );
}

/**
 * The problem to answer with when no signer resolved (§4.5 step 6, §4.6
 * "The outcome of a fetch is classified as follows", §8.1).
 */
export function signerFailureError(
  mode: SignatureMode,
  result: { readonly failure: SignerFailure; readonly reason?: string },
): AppError {
  const who = mode === "provider" ? "provider signing key" : "device key";
  const because = result.reason ? ` (${result.reason})` : "";
  switch (result.failure) {
    case "fetch_failed":
      // The signature was never checked: "try again later", not "bad credentials".
      return AppError.serviceUnavailable({
        detail: `the signer's ${who}s could not be fetched from its home provider${because}; retry later`,
        headers: { "Retry-After": String(KEY_FETCH_RETRY_AFTER_SECONDS) },
      });
    case "refused":
      return AppError.unauthorized({
        detail: `the signer's ${who}s cannot be checked: this provider's outbound-request rules forbid fetching them${because}`,
      });
    case "bad_signature":
      return AppError.unauthorized({ detail: "invalid request signature" });
    case "no_key":
      return AppError.unauthorized({
        detail:
          mode === "provider"
            ? "no provider signing key matches X-OFSCP-Key-ID"
            : "no active device key matches X-OFSCP-Actor/Key-ID",
      });
  }
}

/**
 * Determine the remote peer domain a request asserts, if any — the actor's home
 * domain (user-signed) or the signing provider's domain (provider-signed). Used
 * to apply the §8 allow/deny policy *before* any remote key fetch. Returns
 * `null` for a local identity or a malformed identity header (the latter fails
 * later in resolution as a 401, never reaching the network).
 */
export function remotePeerDomain(
  mode: SignatureMode,
  domainHost: string,
  identity: string,
): string | null {
  if (mode === "provider") {
    const providerDomain = canonicalAuthority(identity);
    return providerDomain === domainHost ? null : providerDomain;
  }
  const at = identity.lastIndexOf("@");
  if (at <= 0 || at === identity.length - 1) return null; // malformed → handled in resolve
  const actorDomain = canonicalAuthority(identity.slice(at + 1));
  return actorDomain === domainHost ? null : actorDomain;
}

/**
 * Resolve a **user** actor's verification key (§4.5 step 6).
 *
 * - **Local** actors (`handle@<this provider's host>`) resolve via
 *   {@link resolveActorKeys}; step 7 of the pipeline does the verify.
 * - **Remote** actors resolve via the §4.6 keys endpoint through the
 *   {@link RemoteUserKeysCache}, verified here ({@link resolveRemote}).
 */
async function resolveActorSigner(
  db: Db,
  domainHost: string,
  actorHeader: string,
  keyId: string,
  userKeysCache: RemoteUserKeysCache,
  target: VerifyTarget,
): Promise<SignerResolution> {
  const at = actorHeader.lastIndexOf("@");
  if (at <= 0 || at === actorHeader.length - 1) return { ok: false, failure: "no_key" };
  const handle = actorHeader.slice(0, at);
  const actorDomain = canonicalAuthority(actorHeader.slice(at + 1));

  if (actorDomain === domainHost) {
    const key = resolveActorKeys(db, handle).find((k) => k.keyId === keyId);
    // Unknown id, revoked (omitted), or wrong owner.
    if (!key) return { ok: false, failure: "no_key" };
    return {
      ok: true,
      signer: {
        publicKey: key.publicKey,
        // Local signer → the handle IS a local handle; safe as a storage key.
        actor: { actor: actorHeader, localHandle: handle, keyId, domain: actorDomain },
      },
    };
  }

  // Remote actor (§4.6). NOTE: no `localHandle` — `handle` names a user of
  // `actorDomain`, not of this provider. See {@link AuthenticatedActor}.
  return resolveRemote(
    (forceRefresh) => userKeysCache.lookupActorKey(actorHeader, keyId, { forceRefresh }),
    target,
    { actor: actorHeader, keyId, domain: actorDomain },
  );
}

/**
 * Resolve a **provider** signer's verification key (§8.1).
 *
 * - A request signed by **this** provider resolves locally via
 *   {@link getProviderSigningKeyById}; step 7 of the pipeline does the verify.
 * - A **remote** provider's key comes from its discovery document
 *   (`provider.publicKeys`) via the {@link RemoteDiscoveryCache}, verified here
 *   ({@link resolveRemote}).
 */
async function resolveProviderSigner(
  db: Db,
  domainHost: string,
  providerHeader: string,
  keyId: string,
  cache: RemoteDiscoveryCache,
  target: VerifyTarget,
): Promise<SignerResolution> {
  const providerDomain = canonicalAuthority(providerHeader);
  // For a provider identity there is no user at all; expose the domain as both
  // the actor string and the domain, and NO `localHandle` (even for our own
  // domain — a provider signature is not a user of this provider).
  const actor: AuthenticatedActor = { actor: providerHeader, keyId, domain: providerDomain };

  if (providerDomain === domainHost) {
    const key = getProviderSigningKeyById(db, keyId);
    if (!key) return { ok: false, failure: "no_key" };
    return { ok: true, signer: { publicKey: key.publicKey, actor } };
  }

  return resolveRemote(
    (forceRefresh) => cache.lookupProviderKey(providerDomain, keyId, { forceRefresh }),
    target,
    actor,
  );
}

/**
 * Resolve + verify a remote signer's key. A cached key that fails to verify
 * forces one re-fetch (§4.6/§8.1 "re-fetch before finally rejecting"); a key
 * that was just fetched and fails is a bad signature. When the re-fetch
 * fails, the request cannot be finally rejected either: `fetch_failed` (503).
 */
async function resolveRemote(
  lookup: (forceRefresh: boolean) => Promise<KeyLookup<{ readonly publicKey: string }>>,
  target: VerifyTarget,
  actor: AuthenticatedActor,
): Promise<SignerResolution> {
  const verifies = (publicKey: string) => verify({ publicKey, ...target });
  const accept = (publicKey: string): SignerResolution => ({
    ok: true,
    signer: { publicKey, actor, verified: true },
  });

  const first = await lookup(false);
  if (first.kind !== "found") return lookupFailure(first);
  if (verifies(first.key.publicKey)) return accept(first.key.publicKey);
  if (first.fresh) return { ok: false, failure: "bad_signature" };

  // The cached key did not verify → the signer may have rotated: re-fetch once.
  const second = await lookup(true);
  if (second.kind !== "found") return lookupFailure(second);
  if (verifies(second.key.publicKey)) return accept(second.key.publicKey);
  return { ok: false, failure: "bad_signature" };
}

function lookupFailure(outcome: Exclude<KeyLookup<unknown>, { kind: "found" }>): SignerResolution {
  switch (outcome.kind) {
    case "no_key":
      return { ok: false, failure: "no_key" };
    case "refused":
      return { ok: false, failure: "refused", reason: outcome.reason };
    case "fetch_failed":
      return { ok: false, failure: "fetch_failed", reason: outcome.reason };
  }
}
