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
 * provider serves, the signature simply won't validate. We additionally reject
 * up front if the actor/provider domain is not this provider's host, which both
 * gives a clear 401 and marks where P7 remote resolution plugs in.
 *
 * ## P7 hooks
 * Remote actor key resolution (a non-local actor domain) and remote provider
 * discovery resolution are out of scope here: both **fail closed** with a 401
 * and a marked comment so P7 can drop in the remote resolver behind the same
 * function boundary.
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
 * A request signed by **this** provider resolves via
 * {@link getProviderSigningKeyById}. A remote provider's key requires fetching
 * its discovery document (`provider.publicKeys`) — that is **P7** and fails
 * closed here.
 */
function resolveProviderSigner(
  db: Db,
  domainHost: string,
  providerHeader: string,
  keyId: string,
): ResolvedSigner | null {
  const providerDomain = canonicalAuthority(providerHeader);

  if (providerDomain !== domainHost) {
    // P7: remote provider resolution fetches the signer's discovery document
    // and selects the matching `provider.publicKeys` entry. Fail closed now.
    return null;
  }

  const key = getProviderSigningKeyById(db, keyId);
  if (!key) return null;

  return {
    publicKey: key.publicKey,
    // For a provider identity there is no user handle; expose the domain as both
    // the actor string and the domain, with an empty handle.
    actor: { actor: providerHeader, handle: "", keyId, domain: providerDomain },
  };
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

    // --- §4.5 step 6: resolve the signer's key (not revoked) → 401 ----------
    const signer =
      mode === "provider"
        ? resolveProviderSigner(db, authority, identity, keyId)
        : resolveActorSigner(db, authority, identity, keyId);
    if (!signer) {
      throw AppError.unauthorized({
        detail:
          mode === "provider"
            ? "no provider signing key matches X-OFSCP-Key-ID (remote provider resolution is P7)"
            : "no active device key matches X-OFSCP-Actor/Key-ID (remote actor resolution is P7)",
      });
    }

    // --- §4.5 step 7: reconstruct canonical string + verify signature → 401 -
    const { path, query } = rawTarget(c);
    const ok = verify({
      publicKey: signer.publicKey,
      authority,
      method: c.req.method,
      path,
      query,
      timestamp,
      nonce,
      contentDigest: digest,
      signature,
    });
    if (!ok) {
      throw AppError.unauthorized({ detail: "invalid request signature" });
    }

    // Authenticated. Authorization (membership/tier) is applied separately.
    c.set("actor", signer.actor);
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
