/**
 * Signed-request verification middleware (spec §4.5, §8.1) — the security gate
 * every authenticated request passes through.
 *
 * {@link requireSignature} enforces the §4.5 checks **in order**, rejecting on
 * the first failure with the noted status (as problem+json via {@link AppError}).
 * The order is load-bearing: doing the body-digest or signature check before the
 * cheap presence/authority/timestamp/replay checks would widen the attack
 * surface, so the sequence below mirrors §4.5 step-for-step.
 *
 * Two identities are supported with one pipeline (§8.1): a **user-signed**
 * request carries `X-OFSCP-Actor` and resolves a device key; a **provider-
 * signed** request carries `X-OFSCP-Provider` and resolves a provider signing
 * key. Pass `{ mode: "provider" }` for the latter (a sibling factory
 * {@link requireProviderSignature} is exported for ergonomics).
 *
 * ## Authority binding (§4.5 step 2)
 * The verifier reconstructs the canonical string using **`config.domain`** as the
 * authority — never a client-supplied Host/authority header. The client signs
 * for the authority it is sending to; if that authority is not the one this
 * provider serves, the signature simply won't validate. The signer's *identity*
 * domain (the actor/provider domain) is resolved separately: a non-local actor
 * fails closed (P7), while a non-local provider is resolved via discovery (§8.1).
 *
 * ## P7 hooks
 * Remote **actor** key resolution (a non-local actor domain) is still out of
 * scope here and **fails closed** with a 401 behind a marked boundary. Remote
 * **provider** resolution is now implemented (§8.1): a provider-signed request
 * from another provider resolves its key via the discovery cache and verifies it
 * (re-fetching once on a verification miss to pick up key rotation).
 */
import {
  HEADER,
  buildCanonicalString,
  canonicalAuthority,
  contentDigest,
  verify,
} from "@forumall/shared";
import type { Context, MiddlewareHandler } from "hono";

import type { Db } from "../db/index.ts";
import { resolveActorKeys } from "../provider/device-keys.ts";
import type { RemoteDiscoveryCache } from "../provider/federation/discovery-cache.ts";
import {
  DEFAULT_NONCE_RETENTION_MS,
  InMemoryNonceStore,
  type NonceStore,
} from "../provider/nonce-store.ts";
import { getProviderSigningKeyById } from "../provider/signing-key.ts";
import { AppError } from "./errors.ts";
import type { AppBindings, AuthenticatedActor } from "./types.ts";

/** Default allowed timestamp skew (±300s, §4.5 step 3). */
export const DEFAULT_TIMESTAMP_SKEW_SECONDS = 300;

/** Identity mode: a user device key (§4.4) or the provider signing key (§8.1). */
export type SignatureMode = "actor" | "provider";

export interface RequireSignatureOptions {
  /** `"actor"` (user device key, default) or `"provider"` (provider key). */
  mode?: SignatureMode;
  /** Replay store; defaults to a shared per-app in-memory store. */
  nonceStore?: NonceStore;
  /** Allowed ±skew for `X-OFSCP-Timestamp`, seconds. Default 300 (§4.5 step 3). */
  skewSeconds?: number;
  /** Nonce retention window, ms. Default 600_000 (≥600s, §4.5 step 4). */
  nonceRetentionMs?: number;
}

/** The selected verification key + the actor/provider identity it belongs to. */
interface ResolvedSigner {
  /** Base64 raw 32-byte Ed25519 public key to verify against. */
  readonly publicKey: string;
  /** Authenticated identity to expose on `c.var.actor`. */
  readonly actor: AuthenticatedActor;
  /**
   * Set by resolvers that must verify internally to decide *which* key resolves
   * (the remote-provider path verifies during discovery-cache resolution so it
   * can re-fetch on a miss). When true the pipeline trusts that result and skips
   * the generic step-7 verify; when false/absent step 7 performs the check.
   */
  readonly verified?: boolean;
}

/** The §4.4.2 inputs a resolver needs to (re)verify a candidate key (§8.1 re-fetch). */
interface VerifyTarget {
  readonly authority: string;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly contentDigest: string;
  readonly signature: string;
}

/** The local-only resolvers, isolated so P7 can extend each behind one boundary. */

/**
 * Resolve a **user** actor's verification key (§4.5 step 6).
 *
 * Local actors (`handle@<this provider's host>`) resolve via
 * {@link resolveActorKeys}. A non-local actor domain is **P7** (remote key
 * fetch via the §4.6 keys endpoint) and fails closed here.
 */
function resolveActorSigner(
  db: Db,
  domainHost: string,
  actorHeader: string,
  keyId: string,
): ResolvedSigner | null {
  const at = actorHeader.lastIndexOf("@");
  if (at <= 0 || at === actorHeader.length - 1) return null; // not `handle@domain`
  const handle = actorHeader.slice(0, at);
  const actorDomain = canonicalAuthority(actorHeader.slice(at + 1));

  if (actorDomain !== domainHost) {
    // P7: remote actor key resolution fetches the actor's §4.6 keys endpoint.
    // Until then we fail closed — a remote-signed request cannot authenticate.
    return null;
  }

  const key = resolveActorKeys(db, handle).find((k) => k.keyId === keyId);
  if (!key) return null; // unknown id, revoked (resolveActorKeys omits revoked), or wrong owner

  return {
    publicKey: key.publicKey,
    actor: { actor: actorHeader, handle, keyId, domain: actorDomain },
  };
}

/**
 * Resolve a **provider** signer's verification key (§8.1).
 *
 * - A request signed by **this** provider resolves locally via
 *   {@link getProviderSigningKeyById}; step 7 of the pipeline does the verify.
 * - A **remote** provider's key is fetched from its discovery document
 *   (`provider.publicKeys`) via the {@link RemoteDiscoveryCache}. Because §8.1
 *   requires a re-fetch on a verification miss (to pick up key rotation), the
 *   verify is performed *here*: we try the cached key, and on a miss force a
 *   discovery refresh and try once more. A signer is returned only if the
 *   signature verifies, and it is flagged `verified` so the pipeline does not
 *   redundantly re-check it.
 */
async function resolveProviderSigner(
  db: Db,
  domainHost: string,
  providerHeader: string,
  keyId: string,
  cache: RemoteDiscoveryCache,
  target: VerifyTarget,
): Promise<ResolvedSigner | null> {
  const providerDomain = canonicalAuthority(providerHeader);

  if (providerDomain === domainHost) {
    const key = getProviderSigningKeyById(db, keyId);
    if (!key) return null;
    return {
      publicKey: key.publicKey,
      // For a provider identity there is no user handle; expose the domain as
      // both the actor string and the domain, with an empty handle.
      actor: { actor: providerHeader, handle: "", keyId, domain: providerDomain },
    };
  }

  // --- Remote provider (§8.1) ----------------------------------------------
  // Resolve the published key, verifying against it; on a miss (unknown key id
  // *or* a key that fails to verify) force one discovery re-fetch and retry,
  // mirroring §4.6 so rotation is picked up promptly.
  const verifyWith = (publicKey: string) => verify({ publicKey, ...target });

  const cached = await cache.getProviderKey(providerDomain, keyId);
  if (cached && verifyWith(cached.publicKey)) {
    return {
      publicKey: cached.publicKey,
      actor: { actor: providerHeader, handle: "", keyId, domain: providerDomain },
      verified: true,
    };
  }

  // Cached key missing or did not verify → force-refresh discovery once.
  const fresh = await cache.getProviderKey(providerDomain, keyId, { forceRefresh: true });
  if (fresh && verifyWith(fresh.publicKey)) {
    return {
      publicKey: fresh.publicKey,
      actor: { actor: providerHeader, handle: "", keyId, domain: providerDomain },
      verified: true,
    };
  }

  return null;
}

/**
 * Extract the raw path and raw query (exactly as sent, before percent-decoding)
 * from the request. The canonical string (§4.4.2) is byte-exact, so we parse the
 * URL line ourselves rather than use Hono's decoded `c.req.path`.
 */
function rawTarget(c: Context): { path: string; query: string } {
  const url = c.req.url;
  // Strip scheme://authority to get the request-target.
  const schemeEnd = url.indexOf("://");
  const afterScheme = schemeEnd === -1 ? url : url.slice(schemeEnd + 3);
  const slash = afterScheme.indexOf("/");
  const target = slash === -1 ? "/" : afterScheme.slice(slash);
  const q = target.indexOf("?");
  if (q === -1) return { path: target, query: "" };
  return { path: target.slice(0, q), query: target.slice(q + 1) };
}

/**
 * Build the §4.5 verification middleware. The returned handler authenticates the
 * request and sets `c.var.actor`, or throws an {@link AppError} on the first
 * failed check (problem+json via the app's `onError`).
 *
 * Later cards apply it per-router, e.g.:
 * ```ts
 * const sig = requireSignature();
 * router.get("/device-keys", sig, (c) => { const { actor } = c.var; ... });
 * router.delete("/device-keys/:keyId", sig, (c) => { ... });
 * ```
 * Reusing a single instance shares the nonce store across the routes it guards.
 */
export function requireSignature(
  opts: RequireSignatureOptions = {},
): MiddlewareHandler<AppBindings> {
  const mode: SignatureMode = opts.mode ?? "actor";
  const skewSeconds = opts.skewSeconds ?? DEFAULT_TIMESTAMP_SKEW_SECONDS;
  const nonceRetentionMs = opts.nonceRetentionMs ?? DEFAULT_NONCE_RETENTION_MS;
  // One store per middleware instance unless the caller injects a shared one.
  const nonceStore = opts.nonceStore ?? new InMemoryNonceStore();
  const identityHeader = mode === "provider" ? HEADER.PROVIDER : HEADER.ACTOR;

  return async (c, next) => {
    await verifyAndSetActor(c, {
      mode,
      skewSeconds,
      nonceRetentionMs,
      nonceStore,
      identityHeader,
    });
    await next();
  };
}

/** Internal resolved config shared by `requireSignature` + `optionalSignature`. */
interface VerifyContext {
  readonly mode: SignatureMode;
  readonly skewSeconds: number;
  readonly nonceRetentionMs: number;
  readonly nonceStore: NonceStore;
  readonly identityHeader: string;
}

/**
 * The §4.5 verification core. Runs the ordered checks against the request and,
 * on success, sets `c.var.actor`. Throws an {@link AppError} on the first failed
 * check. Shared by {@link requireSignature} (always required) and
 * {@link optionalSignature} (only invoked when signing headers are present).
 */
async function verifyAndSetActor(c: Context, vctx: VerifyContext): Promise<void> {
  const { mode, skewSeconds, nonceRetentionMs, nonceStore, identityHeader } = vctx;
  {
    const { config, db } = c.var;
    const h = (name: string) => c.req.header(name);

    // --- §4.5 step 1: all six signing headers present → 401 -----------------
    const identity = h(identityHeader);
    const keyId = h(HEADER.KEY_ID);
    const timestamp = h(HEADER.TIMESTAMP);
    const nonce = h(HEADER.NONCE);
    const digest = h(HEADER.CONTENT_DIGEST);
    const signature = h(HEADER.SIGNATURE);
    if (!identity || !keyId || !timestamp || !nonce || !digest || !signature) {
      throw AppError.unauthorized({
        detail: "missing one or more required X-OFSCP-* signing headers",
      });
    }

    // --- §4.5 step 2: authority binding → 401 -------------------------------
    // The verifier uses config.domain (canonicalized) as the authority when
    // reconstructing the canonical string. A client-supplied Host/authority is
    // never trusted here; that is what stops cross-host replay.
    const authority = canonicalAuthority(config.domain);

    // --- §4.5 step 3: timestamp within ±skew of now → 401 -------------------
    const tsMillis = Date.parse(timestamp);
    if (Number.isNaN(tsMillis)) {
      throw AppError.unauthorized({
        detail: "X-OFSCP-Timestamp is not a valid RFC 3339 timestamp",
      });
    }
    if (Math.abs(Date.now() - tsMillis) > skewSeconds * 1000) {
      throw AppError.unauthorized({
        detail: `X-OFSCP-Timestamp is outside the allowed ±${skewSeconds}s window`,
      });
    }

    // --- §4.5 step 4: (Key-ID, Nonce) not already seen → 401; remember it ----
    if (nonceStore.has(keyId, nonce)) {
      throw AppError.unauthorized({ detail: "replayed (key id, nonce): nonce already used" });
    }
    nonceStore.remember(keyId, nonce, nonceRetentionMs);

    // --- §4.5 step 5: recompute SHA-256 of the raw body → 400 ---------------
    // Read the body once as bytes; Hono caches it, so a downstream c.req.json()
    // (or .text()/.arrayBuffer()) still works after this.
    const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
    if (contentDigest(bodyBytes) !== digest) {
      throw AppError.badRequest({
        detail: "X-OFSCP-Content-Digest does not match the SHA-256 of the request body",
      });
    }

    // The §4.4.2 request target, reconstructed for both key resolution (the
    // remote-provider path verifies during resolution) and step 7.
    const { path, query } = rawTarget(c);
    const target: VerifyTarget = {
      authority,
      method: c.req.method,
      path,
      query,
      timestamp,
      nonce,
      contentDigest: digest,
      signature,
    };

    // --- §4.5 step 6: resolve the signer's key (not revoked) → 401 ----------
    // The remote-provider path (§8.1) verifies internally so it can re-fetch
    // discovery on a verification miss; it flags `verified` to skip step 7.
    const signer =
      mode === "provider"
        ? await resolveProviderSigner(db, authority, identity, keyId, c.var.discoveryCache, target)
        : resolveActorSigner(db, authority, identity, keyId);
    if (!signer) {
      throw AppError.unauthorized({
        detail:
          mode === "provider"
            ? "no provider signing key matches X-OFSCP-Key-ID (unknown key or unresolvable provider)"
            : "no active device key matches X-OFSCP-Actor/Key-ID (remote actor resolution is P7)",
      });
    }

    // --- §4.5 step 7: reconstruct canonical string + verify signature → 401 -
    // Skip when the resolver already verified (remote provider via §8.1).
    const ok = signer.verified ?? verify({ publicKey: signer.publicKey, ...target });
    if (!ok) {
      throw AppError.unauthorized({ detail: "invalid request signature" });
    }

    // Authenticated. Authorization (membership/tier) is applied separately.
    c.set("actor", signer.actor);
  }
}

/**
 * Optional-authentication variant of {@link requireSignature} for routes that
 * are readable both signed and unsigned (e.g. `GET /api/groups/{id}` — public
 * groups are readable by anyone, private groups require an authenticated
 * member). Behavior:
 *
 *  - **No** `X-OFSCP-*` signing headers present → continue with no `c.var.actor`
 *    (the handler decides whether anonymous access is allowed).
 *  - **Any** signing header present → run the full §4.5 verification; a
 *    present-but-invalid signature still fails (401/400), so a forged identity
 *    can never slip through.
 *
 * Shares the verification core and (per-instance) nonce store with
 * {@link requireSignature}.
 */
export function optionalSignature(
  opts: RequireSignatureOptions = {},
): MiddlewareHandler<AppBindings> {
  const mode: SignatureMode = opts.mode ?? "actor";
  const skewSeconds = opts.skewSeconds ?? DEFAULT_TIMESTAMP_SKEW_SECONDS;
  const nonceRetentionMs = opts.nonceRetentionMs ?? DEFAULT_NONCE_RETENTION_MS;
  const nonceStore = opts.nonceStore ?? new InMemoryNonceStore();
  const identityHeader = mode === "provider" ? HEADER.PROVIDER : HEADER.ACTOR;

  // A request is "signing" if it carries ANY of the X-OFSCP signing headers; if
  // so we verify fully (so a partial/invalid set 401s rather than passing as
  // anonymous). Absent entirely → continue unauthenticated.
  const SIGNING_HEADERS = [
    identityHeader,
    HEADER.KEY_ID,
    HEADER.TIMESTAMP,
    HEADER.NONCE,
    HEADER.CONTENT_DIGEST,
    HEADER.SIGNATURE,
  ];

  return async (c, next) => {
    const present = SIGNING_HEADERS.some((name) => c.req.header(name) !== undefined);
    if (present) {
      await verifyAndSetActor(c, {
        mode,
        skewSeconds,
        nonceRetentionMs,
        nonceStore,
        identityHeader,
      });
    }
    await next();
  };
}

/** Provider-signed (§8.1) variant of {@link requireSignature}. */
export function requireProviderSignature(
  opts: Omit<RequireSignatureOptions, "mode"> = {},
): MiddlewareHandler<AppBindings> {
  return requireSignature({ ...opts, mode: "provider" });
}

/** For reuse: build the canonical string a request would have signed (debug/test). */
export function reconstructCanonical(c: Context, authority: string): string {
  const { path, query } = rawTarget(c);
  return buildCanonicalString({
    authority: canonicalAuthority(authority),
    method: c.req.method,
    path,
    query,
    timestamp: c.req.header(HEADER.TIMESTAMP) ?? "",
    nonce: c.req.header(HEADER.NONCE) ?? "",
    contentDigest: c.req.header(HEADER.CONTENT_DIGEST) ?? "",
  });
}
