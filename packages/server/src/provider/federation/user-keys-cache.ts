/**
 * Remote actor public-key cache (spec §4.6, §8.1) — resolves a remote user's
 * device keys so we can verify their user-signed requests (§4.5 step 6) when the
 * actor's home provider is **not** this one.
 *
 * Mirrors the {@link RemoteDiscoveryCache} (the provider-key analogue): it
 * fetches `GET https://{domain}/.well-known/ofscp/users/{handle}/keys` through
 * the injected {@link FederationFetch}, validates the body against
 * `UserKeysResponseSchema`, and caches the parsed keys.
 *
 * ## Caching + re-fetch (§4.6)
 *  - The cache honors the response's `cache_until` timestamp, clamped to
 *    `[minTtlMs, maxTtlMs]` (default ceiling 1 h, matching the §4.7.1 guidance to
 *    keep windows short so revocations propagate promptly).
 *  - {@link RemoteUserKeysCache.getActorKey} returns the cached key entry for a
 *    `key_id`, or `null`. §4.6 requires: "on a verification failure for a key_id
 *    they believe should be valid, [verifiers] MUST re-fetch before finally
 *    rejecting". The signature middleware drives that by calling again with
 *    `{ forceRefresh: true }` on a verify miss — and we also re-fetch
 *    automatically when a cache hit simply lacks the requested key (the actor may
 *    have registered a new device since we cached).
 *
 * The cache is per-app (constructed in `createApp`) and exposed on
 * `c.var.userKeysCache`. It carries no secrets — only public device keys.
 */
import {
  type UserKeysResponse,
  UserKeysResponseSchema,
  canonicalAuthority,
} from "@forumall/shared";

import { type FederationFetch, defaultFederationFetch, federationGet } from "./http.ts";

/** A resolved remote actor device key (the verify target). */
export interface RemoteActorKey {
  readonly keyId: string;
  /** Base64 raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  readonly algorithm: string;
}

/** Tunables for the cache TTL derivation (all ms). */
export interface UserKeysCacheOptions {
  /** TTL when the peer sets no usable `cache_until`. Default 300_000 (5 min). */
  readonly defaultTtlMs?: number;
  /** Lower bound applied to any derived TTL. Default 1_000. */
  readonly minTtlMs?: number;
  /** Upper bound applied to any derived TTL. Default 3_600_000 (1 h, §4.7.1). */
  readonly maxTtlMs?: number;
  /** Injected fetch (default: global `fetch`). */
  readonly federationFetch?: FederationFetch;
  /** Clock, overridable in tests. Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 300_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 3_600_000;

interface CacheEntry {
  readonly response: UserKeysResponse;
  /** Epoch ms after which the entry is stale. */
  readonly expiresAt: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** A cache key uniquely identifying an actor (`handle@domain`, canonicalized). */
function actorCacheKey(handle: string, host: string): string {
  return `${handle}@${host}`;
}

export class RemoteUserKeysCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #fetch: FederationFetch;
  readonly #defaultTtlMs: number;
  readonly #minTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #now: () => number;
  /** Total successful network fetches — exposed for tests (cache-hit assertions). */
  #fetchCount = 0;

  constructor(opts: UserKeysCacheOptions = {}) {
    this.#fetch = opts.federationFetch ?? defaultFederationFetch;
    this.#defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#minTtlMs = opts.minTtlMs ?? MIN_TTL_MS;
    this.#maxTtlMs = opts.maxTtlMs ?? MAX_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** Network fetches performed so far (cache misses + forced refetches). */
  get fetchCount(): number {
    return this.#fetchCount;
  }

  /** Derive a TTL (ms) from the response's `cache_until`, bounded to [min, max]. */
  #deriveTtlMs(response: UserKeysResponse): number {
    const at = Date.parse(response.cache_until);
    if (Number.isNaN(at)) return clamp(this.#defaultTtlMs, this.#minTtlMs, this.#maxTtlMs);
    return clamp(at - this.#now(), this.#minTtlMs, this.#maxTtlMs);
  }

  /**
   * Fetch (or return the cached) keys document for `handle@domain`. With
   * `forceRefresh` the cached entry is ignored and the network is hit.
   *
   * Returns `null` if the document can't be fetched or fails schema validation;
   * any cached copy is left intact on a failed forced refresh.
   */
  async #getDocument(
    handle: string,
    host: string,
    forceRefresh: boolean,
  ): Promise<UserKeysResponse | null> {
    const cacheKey = actorCacheKey(handle, host);
    if (!forceRefresh) {
      const hit = this.#entries.get(cacheKey);
      if (hit && hit.expiresAt > this.#now()) return hit.response;
    }

    const url = `https://${host}/.well-known/ofscp/users/${encodeURIComponent(handle)}/keys`;
    let res: Response;
    try {
      res = await federationGet(host, url, {}, this.#fetch);
    } catch {
      return this.#entries.get(cacheKey)?.response ?? null;
    }
    if (!res.ok) return this.#entries.get(cacheKey)?.response ?? null;

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return this.#entries.get(cacheKey)?.response ?? null;
    }
    const result = UserKeysResponseSchema.safeParse(parsed);
    if (!result.success) return this.#entries.get(cacheKey)?.response ?? null;

    this.#fetchCount += 1;
    const ttl = this.#deriveTtlMs(result.data);
    this.#entries.set(cacheKey, { response: result.data, expiresAt: this.#now() + ttl });
    return result.data;
  }

  /**
   * Resolve `actor`'s (`handle@domain`) active device key for `keyId`, or `null`.
   *
   * On a cache hit whose document lacks `keyId`, re-fetches once before giving up
   * (§4.6 rotation/revocation rule), unless `forceRefresh` already forced the
   * network. Pass `{ forceRefresh: true }` to force the network unconditionally
   * (the middleware does this on a verification miss for a key it believed valid).
   */
  async getActorKey(
    actor: string,
    keyId: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<RemoteActorKey | null> {
    const at = actor.lastIndexOf("@");
    if (at <= 0 || at === actor.length - 1) return null; // not `handle@domain`
    const handle = actor.slice(0, at);
    const host = canonicalAuthority(actor.slice(at + 1));

    const forced = opts.forceRefresh ?? false;
    const doc = await this.#getDocument(handle, host, forced);
    const found = doc ? selectKey(doc, keyId) : null;
    if (found || forced) return found;

    // Key absent from the (possibly cached) document → re-fetch once in case the
    // actor registered a new device since we cached, then look again.
    const refreshed = await this.#getDocument(handle, host, true);
    return refreshed ? selectKey(refreshed, keyId) : null;
  }

  /** Drop a cached actor entry (e.g. on explicit invalidation). */
  invalidate(actor: string): void {
    const at = actor.lastIndexOf("@");
    if (at <= 0 || at === actor.length - 1) return;
    const handle = actor.slice(0, at);
    const host = canonicalAuthority(actor.slice(at + 1));
    this.#entries.delete(actorCacheKey(handle, host));
  }
}

/** Pick the matching active key from a keys-response document. */
function selectKey(doc: UserKeysResponse, keyId: string): RemoteActorKey | null {
  const entry = doc.keys.find((k) => k.key_id === keyId);
  if (!entry) return null;
  return { keyId: entry.key_id, publicKey: entry.public_key, algorithm: entry.algorithm };
}
