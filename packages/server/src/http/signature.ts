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
 * is resolved via the §4.6 keys endpoint, a non-local provider via discovery
 * (§8.1).
 *
 * ## Signer resolution (§4.5 step 6, §4.6, §8.1)
 * Key resolution lives in `signer-resolution.ts`: local signers resolve from
 * this provider's tables; remote actors from their home provider's §4.6 keys
 * endpoint ({@link RemoteUserKeysCache}); remote providers from discovery
 * ({@link RemoteDiscoveryCache}). It reports WHY a key did not resolve, which
 * picks the status: no matching key or an outbound-rules refusal → `401`; the
 * keys could not be fetched → `503` + `Retry-After`.
 *
 * ## Federation policy (§8 Authorization)
 * For any **remote** signer the §8 allow/deny policy ({@link isProviderAllowed})
 * is checked *before* any network key fetch — a disallowed peer is rejected with
 * a **403** without resolving keys, even if a cached key would match (§4.6).
 * Local actors are unaffected.
 *
 * ## Local vs remote identity (read this before using the handle)
 * Because a remote actor authenticates here just as fully as a local one, the
 * resolved {@link AuthenticatedActor} exposes a bare handle ONLY when the signer
 * belongs to this provider (`localHandle`) — see the identity rule documented on
 * that type. {@link requireLocalActor} (middleware) and
 * {@link requireLocalHandle} (in-handler) are the two ways to demand a local
 * caller; everything else must key storage on the full `actor`.
 */
import {
  HEADER,
  buildCanonicalString,
  canonicalAuthority,
  contentDigest,
  isCanonicalActor,
  isCanonicalAuthority,
  verify,
} from "@forumall/shared";
import type { Context, MiddlewareHandler } from "hono";

import type { RemoteDiscoveryCache } from "../provider/federation/discovery-cache.ts";
import { isProviderAllowed } from "../provider/federation/policy.ts";
import type { RemoteUserKeysCache } from "../provider/federation/user-keys-cache.ts";
import {
  type NonceStore,
  nonceKeyId,
  nonceRetentionMs as retentionForSkew,
} from "../provider/nonce-store.ts";
import { AppError } from "./errors.ts";
import {
  type VerifyTarget,
  remotePeerDomain,
  resolveSigner,
  signerFailureError,
} from "./signer-resolution.ts";
import type { AppBindings, AuthenticatedActor, SignatureMode } from "./types.ts";

/** Default allowed timestamp skew (±300s, §4.5 step 3). */
export const DEFAULT_TIMESTAMP_SKEW_SECONDS = 300;

/** Identity mode: a user device key (§4.4) or the provider signing key (§8.1). */
export type { SignatureMode } from "./types.ts";

export interface RequireSignatureOptions {
  /** `"actor"` (user device key, default) or `"provider"` (provider key). */
  mode?: SignatureMode;
  /**
   * Replay store override (tests only). Defaults to the single provider-wide
   * store on `c.var.nonceStore` (#21) — do not pass this in application code,
   * or the route silently opts back out of the shared replay protection.
   */
  nonceStore?: NonceStore;
  /** Allowed ±skew for `X-OFSCP-Timestamp`, seconds. Default 300 (§4.5 step 3). */
  skewSeconds?: number;
  /** Nonce retention window, ms. Default `2 · skewSeconds` (600s; §4.5 step 4). */
  nonceRetentionMs?: number;
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
 * Every instance — across every router — shares the ONE provider-wide replay
 * store on `c.var.nonceStore` (#21), resolved per-request rather than captured
 * at construction time, so a `(key_id, nonce)` pair burned on any route (or the
 * WS handshake) is rejected on all of them. Pass `nonceStore` in
 * {@link RequireSignatureOptions} only to override it for a test.
 */
export function requireSignature(
  opts: RequireSignatureOptions = {},
): MiddlewareHandler<AppBindings> {
  const mode: SignatureMode = opts.mode ?? "actor";
  const skewSeconds = opts.skewSeconds ?? DEFAULT_TIMESTAMP_SKEW_SECONDS;
  const nonceRetentionMs = opts.nonceRetentionMs ?? retentionForSkew(skewSeconds);
  const identityHeader = mode === "provider" ? HEADER.PROVIDER : HEADER.ACTOR;

  return async (c, next) => {
    await verifyAndSetActor(c, {
      mode,
      skewSeconds,
      nonceRetentionMs,
      // Resolved per-request (not captured at construction time) so every
      // instance of this middleware, app-wide, shares one store (#21).
      nonceStore: opts.nonceStore ?? c.var.nonceStore,
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

    // --- §2.2: the identity header MUST be in canonical form → 401 ----------
    // We REJECT a non-canonical spelling (`Alice@a.test`, `alice@a.test:443`,
    // `a.test.`) rather than converting it, so every comparison, key lookup,
    // allow/deny decision and stored row downstream sees exactly one spelling of
    // each actor/provider. Checked before any policy decision or network fetch.
    if (mode === "provider" ? !isCanonicalAuthority(identity) : !isCanonicalActor(identity)) {
      throw AppError.unauthorized({
        detail: `${identityHeader} must be in canonical form (OFSCP §2.2)`,
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
    // Skew, warm-up and nonce expiry are all measured on the replay store's
    // clock (§4.5: one clock); for the default store that is `Date.now`.
    const now = nonceStore.now();
    if (Math.abs(now - tsMillis) > skewSeconds * 1000) {
      throw AppError.unauthorized({
        detail: `X-OFSCP-Timestamp is outside the allowed ±${skewSeconds}s window`,
      });
    }

    // --- §4.5 "Restarts": replay-store warm-up → 503 + Retry-After ----------
    // A replay store that does not survive a restart (ours is in-memory) has
    // forgotten nonces that are still replayable: one recorded just before the
    // restart may carry a timestamp up to `skew` ahead of that moment. So every
    // signature timestamped earlier than T₀ + skew is rejected, where T₀ is when
    // the current store began accepting entries. This is "try again later", not
    // "bad credentials", hence 503 (never 401), with a Retry-After of at least
    // the time left until T₀ + skew; the client must re-sign with a fresh
    // timestamp and nonce. (The WS `authenticate` handshake is exempt — its
    // challenge nonce is server-issued per connection — and does not come here.)
    const t0 = nonceStore.startedAt;
    if (t0 !== null) {
      const warmupEnd = t0 + skewSeconds * 1000;
      if (tsMillis < warmupEnd) {
        // At least the time until T₀ + skew on OUR clock — and, for a client
        // whose clock lags ours, until ITS clock reaches T₀ + skew (its next
        // timestamp is ≈ tsMillis + elapsed): so the larger of the two gaps.
        // Rounded up, and ≥1s.
        const remainingMs = Math.max(warmupEnd - now, warmupEnd - tsMillis);
        const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000));
        throw AppError.serviceUnavailable({
          detail:
            "replay store is warming up after a restart; re-sign the request with a fresh timestamp and nonce after Retry-After",
          headers: { "Retry-After": String(retryAfter) },
        });
      }
    }

    // --- §4.5 step 4: (Key-ID, Nonce) not already seen → 401 ----------------
    // Namespaced by signer kind (#21): the store is now shared provider-wide
    // across actor- and provider-mode requests (and the WS handshake), so the
    // two independently-chosen key_id spaces must not be able to collide.
    // The pair is only RECORDED once the signature has verified (after step 7,
    // below), so unauthenticated junk can never fill the store.
    const nsKeyId = nonceKeyId(mode, keyId);
    if (nonceStore.has(nsKeyId, nonce)) {
      throw AppError.unauthorized({ detail: "replayed (key id, nonce): nonce already used" });
    }

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

    // --- §8 Authorization: federation allow/deny policy → 403 ---------------
    // Applied to REMOTE signers only (a remote actor's home domain or a remote
    // provider's domain), and BEFORE any remote key fetch so we never resolve
    // keys for a denied peer. Local identities skip this entirely.
    const peerDomain = remotePeerDomain(mode, authority, identity);
    if (peerDomain !== null && !isProviderAllowed(config, peerDomain)) {
      throw AppError.forbidden({
        detail: `federation with ${peerDomain} is not permitted by this provider's policy`,
      });
    }

    // --- §4.5 step 6: resolve the signer's key (not revoked) → 401 / 503 ---
    // Remote paths (§4.6 actor, §8.1 provider) verify internally so they can
    // re-fetch on a verification miss, and flag `verified` to skip step 7.
    // No matching key or an outbound-rules refusal → 401; keys that could not
    // be fetched → 503 + Retry-After (signer-resolution.ts).
    const resolution = await resolveSigner(mode, {
      db,
      domainHost: authority,
      identity,
      keyId,
      userKeysCache: c.var.userKeysCache,
      discoveryCache: c.var.discoveryCache,
      target,
    });
    if (!resolution.ok) throw signerFailureError(mode, resolution);
    const { signer } = resolution;

    // --- §4.5 step 7: reconstruct canonical string + verify signature → 401 -
    // Skip when the resolver already verified (the remote paths).
    const ok = signer.verified ?? verify({ publicKey: signer.publicKey, ...target });
    if (!ok) {
      throw AppError.unauthorized({ detail: "invalid request signature" });
    }

    // Verified: now burn the (key id, nonce) pair. Re-check first — a concurrent
    // copy of this request may have verified while we awaited key resolution —
    // and do the check + record with no await in between, so it is atomic on
    // the single JS thread.
    if (nonceStore.has(nsKeyId, nonce)) {
      throw AppError.unauthorized({ detail: "replayed (key id, nonce): nonce already used" });
    }
    if (!nonceStore.remember(nsKeyId, nonce, nonceRetentionMs)) {
      // §4.5: fail closed with 503 + Retry-After rather than evict a live entry.
      // Entries expire continuously and the store re-sweeps at least every
      // 60s, so a minute is a sensible back-off.
      throw AppError.serviceUnavailable({
        detail: "replay store is full; retry later",
        headers: { "Retry-After": "60" },
      });
    }

    // Authenticated. Authorization (membership/tier) is applied separately.
    //
    // NOTE the identity shape: `signer.actor.localHandle` is set by the resolvers
    // ONLY for a user actor whose domain equals `authority` (= this provider's
    // `canonicalAuthority(config.domain)`, the same locality notion the DM reads
    // use). A remote actor (§4.6) and a provider identity (§8.1) carry no local
    // handle at all, so no handler can accidentally key local storage on a
    // foreign namespace's handle. See {@link AuthenticatedActor}.
    c.set("actor", signer.actor);
    // Record WHICH identity verified, for routes that accept either (§8.1).
    c.set("signatureMode", mode);
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
 * Shares the verification core with {@link requireSignature}, including the
 * ONE provider-wide nonce store on `c.var.nonceStore` (#21).
 */
export function optionalSignature(
  opts: RequireSignatureOptions = {},
): MiddlewareHandler<AppBindings> {
  const mode: SignatureMode = opts.mode ?? "actor";
  const skewSeconds = opts.skewSeconds ?? DEFAULT_TIMESTAMP_SKEW_SECONDS;
  const nonceRetentionMs = opts.nonceRetentionMs ?? retentionForSkew(skewSeconds);
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
        nonceStore: opts.nonceStore ?? c.var.nonceStore,
        identityHeader,
      });
    }
    await next();
  };
}

/**
 * Accept EITHER identity on one route: a **user-signed** request (§4.4, the
 * actor's device key) or a **provider-signed** one (§8.1, the peer's signing
 * key). Needed where the spec defines the same operation with two delivery
 * shapes — e.g. a DM edit/delete (§8.3), which the AUTHOR may deliver directly
 * to the message's home provider (user-signed) *and* which a peer may forward on
 * one of its users' behalf (provider-signed).
 *
 * The mode is chosen by which identity header the request carries:
 * `X-OFSCP-Provider` present → provider (§8.1); otherwise the user path (§4.4) —
 * including when NO identity header is present, so a headerless request still
 * fails with the exact §4.5 step-1 401. The full ordered §4.5 pipeline runs
 * either way, sharing the ONE provider-wide nonce store (#21) via
 * `c.var.nonceStore` — namespaced per mode (see {@link nonceKeyId}) so an
 * actor-mode and a provider-mode request on this same route still can't
 * collide with each other. The chosen mode is exposed on `c.var.signatureMode`
 * so the handler can tell whose authority it is acting on: a user-signed
 * request may only act as ITSELF, while a provider-signed one names its user
 * out-of-band (a provider-signed request has no `X-OFSCP-Actor`) and must be
 * trusted only for that provider's own users.
 */
export function requireActorOrProviderSignature(
  opts: Omit<RequireSignatureOptions, "mode"> = {},
): MiddlewareHandler<AppBindings> {
  const skewSeconds = opts.skewSeconds ?? DEFAULT_TIMESTAMP_SKEW_SECONDS;
  const nonceRetentionMs = opts.nonceRetentionMs ?? retentionForSkew(skewSeconds);

  return async (c, next) => {
    const mode: SignatureMode = c.req.header(HEADER.PROVIDER) !== undefined ? "provider" : "actor";
    await verifyAndSetActor(c, {
      mode,
      skewSeconds,
      nonceRetentionMs,
      nonceStore: opts.nonceStore ?? c.var.nonceStore,
      identityHeader: mode === "provider" ? HEADER.PROVIDER : HEADER.ACTOR,
    });
    await next();
  };
}

/**
 * The authenticated caller's handle **in this provider's namespace**, or a clean
 * rejection if there isn't one.
 *
 * Use this (never a handle split out of `actor.actor`) wherever a route reads or
 * writes provider-local, per-user storage: `users`, `presence`,
 * `privacy_settings`, `contacts`, `read_markers`, `follows`, notification prefs /
 * feed, push subscriptions, notification endpoints, DM inboxes keyed by `owner`.
 *
 *  - **401** when the request is not authenticated at all (defensive: unreachable
 *    behind `requireSignature()`).
 *  - **403** when the caller authenticated as a REMOTE actor (§4.6) or as a
 *    PROVIDER (§8.1). Neither has an account on this provider, so there is no
 *    local record for them to act on — and treating their bare handle as a local
 *    one would hand them the local user of the same name.
 *
 * MUST run after `requireSignature()`. {@link requireLocalActor} is the
 * middleware form, for mounting on a whole router.
 */
export function requireLocalHandle(c: Context<AppBindings>): string {
  const actor = c.var.actor;
  if (!actor) {
    throw AppError.unauthorized({ detail: "authentication required" });
  }
  const localHandle = actor.localHandle;
  if (localHandle === undefined) {
    throw AppError.forbidden({
      detail: "this endpoint serves only users of this provider; sign in at your home provider",
    });
  }
  return localHandle;
}

/**
 * Middleware form of {@link requireLocalHandle}: reject any caller that is not a
 * user of THIS provider with a 403, before the handler runs.
 *
 * Mounted after `requireSignature()` on every `/api/me/*` router, the §10
 * notification-endpoint router, the push-subscription routes, and the provider
 * admin guard — routes whose entire subject matter is the caller's own
 * provider-local record, which a remote actor (§4.6) simply does not have. It is
 * NOT mounted on routes that legitimately serve remote members (group/channel
 * reads, DM history + edit/delete/reaction, the federation ingest); those key
 * storage on the full `actor` instead.
 *
 * ```ts
 * const signed = requireSignature();
 * const local = requireLocalActor();
 * router.get("/follows", signed, local, (c) => { const me = requireLocalHandle(c); … });
 * ```
 */
export function requireLocalActor(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    requireLocalHandle(c);
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
