/**
 * Remote actor public-key cache (spec §4.6, §8.1) — resolves a remote user's
 * device keys so we can verify their user-signed requests (§4.5 step 6) when the
 * actor's home provider is **not** this one.
 *
 * Mirrors the {@link RemoteDiscoveryCache} (the provider-key analogue): it
 * fetches `GET https://{domain}/.well-known/ofscp/users/{handle}/keys` through
 * the injected {@link FederationFetch}, validates the body, and caches it.
 *
 * ## Validity (§4.6)
 * A keys response is used only if it matches `UserKeysResponseSchema` AND its
 * `actor`, canonicalized (§2.2), equals the actor whose keys were requested.
 * A response naming anyone else is a fetch failure; none of its keys are used.
 * A `404` means "no keys", exactly like an empty `keys` list.
 *
 * ## Caching + re-fetch (§4.6)
 *  - An entry is valid until the response's `cache_until`, capped at
 *    `maxTtlMs` (default 1 h, the §4.7.1 guidance to keep windows short so
 *    revocations propagate promptly). A `cache_until` already past is not
 *    cached at all. An expired entry is never used — not even when a re-fetch
 *    fails (see `key-lookup.ts`).
 *  - {@link RemoteUserKeysCache.lookupActorKey} reports a {@link KeyLookup}:
 *    an unexpired entry holding the key answers without a fetch; otherwise
 *    (no entry, key absent, or `forceRefresh`) it fetches once and reports why
 *    the key did or did not resolve. The signature middleware forces a refresh
 *    when a CACHED key fails to verify (§4.6 "fails verification against a key
 *    they believe should be valid").
 *  - Fetches are bounded per actor by a {@link RefetchLimiter} (§4.6 "MAY
 *    limit these re-fetches per actor", §8 Outbound requests): concurrent
 *    lookups share one in-flight fetch, and at most one fetch starts per
 *    `refetchIntervalMs` (default {@link DEFAULT_REFETCH_INTERVAL_MS}). A
 *    lookup that needs a fetch inside the interval is `rate_limited`, with the
 *    time until one is allowed (→ `503` + `Retry-After`).
 *
 * The cache is per-app (constructed in `createApp`) and exposed on
 * `c.var.userKeysCache`. It carries no secrets — only public device keys.
 */
import {
  type UserKeysResponse,
  UserKeysResponseSchema,
  canonicalActor,
  isCanonicalActor,
} from "@forumall/shared";

import { type FederationFetch, defaultFederationFetch } from "./http.ts";
import { type DocumentFetch, type KeyLookup, fetchKeyDocument, lookupKey } from "./key-lookup.ts";
import { DEFAULT_REFETCH_INTERVAL_MS, RefetchLimiter } from "./refetch-limiter.ts";

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
  /** Upper bound applied to any derived TTL. Default 3_600_000 (1 h, §4.7.1). */
  readonly maxTtlMs?: number;
  /**
   * Minimum time between two network fetches of one actor's keys (§4.6 "MAY
   * limit these re-fetches per actor"). Default {@link DEFAULT_REFETCH_INTERVAL_MS}
   * (1 s); `0` disables the limit (concurrent lookups still share one fetch).
   */
  readonly refetchIntervalMs?: number;
  /** Injected transport (default: the egress-guarded {@link defaultFederationFetch}). */
  readonly federationFetch?: FederationFetch;
  /** Clock, overridable in tests. Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 300_000;
const MAX_TTL_MS = 3_600_000;

interface CacheEntry {
  readonly response: UserKeysResponse;
  /** Epoch ms after which the entry is stale. */
  readonly expiresAt: number;
}

export class RemoteUserKeysCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #fetch: FederationFetch;
  readonly #defaultTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #now: () => number;
  readonly #limiter: RefetchLimiter<DocumentFetch<UserKeysResponse>>;
  /** Total successful network fetches — exposed for tests (cache-hit assertions). */
  #fetchCount = 0;

  constructor(opts: UserKeysCacheOptions = {}) {
    this.#fetch = opts.federationFetch ?? defaultFederationFetch;
    this.#defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#maxTtlMs = opts.maxTtlMs ?? MAX_TTL_MS;
    this.#now = opts.now ?? Date.now;
    this.#limiter = new RefetchLimiter({
      intervalMs: opts.refetchIntervalMs ?? DEFAULT_REFETCH_INTERVAL_MS,
      now: this.#now,
    });
  }

  /** Successful network fetches so far (cache misses + forced refetches). */
  get fetchCount(): number {
    return this.#fetchCount;
  }

  /**
   * How long (ms) a response may be cached: until its `cache_until` (or the
   * default when unparseable), never beyond `maxTtlMs`. ≤ 0 means "do not cache".
   */
  #ttlMs(response: UserKeysResponse): number {
    const at = Date.parse(response.cache_until);
    const ttl = Number.isNaN(at) ? this.#defaultTtlMs : at - this.#now();
    return Math.min(ttl, this.#maxTtlMs);
  }

  /** The unexpired cached document for `actor`, if any. */
  #cached(actor: string): UserKeysResponse | null {
    const hit = this.#entries.get(actor);
    return hit && hit.expiresAt > this.#now() ? hit.response : null;
  }

  /** Fetch `actor`'s keys document once; cache it on success. */
  async #refresh(
    actor: string,
    handle: string,
    host: string,
  ): Promise<DocumentFetch<UserKeysResponse>> {
    const fetched = await fetchKeyDocument<UserKeysResponse>(this.#fetch, {
      host,
      url: `https://${host}/.well-known/ofscp/users/${encodeURIComponent(handle)}/keys`,
      notFoundMeansNoKeys: true,
      validate: (body) => {
        const parsed = UserKeysResponseSchema.safeParse(body);
        if (!parsed.success) return { ok: false, reason: `invalid keys response for ${actor}` };
        // §4.6: a response naming any other actor is not a valid keys response.
        if (canonicalActor(parsed.data.actor) !== actor) {
          return { ok: false, reason: `keys response for ${actor} names ${parsed.data.actor}` };
        }
        return { ok: true, doc: parsed.data };
      },
    });
    if (fetched.kind === "ok") {
      this.#fetchCount += 1;
      const ttl = this.#ttlMs(fetched.doc);
      if (ttl > 0) {
        this.#entries.set(actor, { response: fetched.doc, expiresAt: this.#now() + ttl });
      } else {
        this.#entries.delete(actor);
      }
    } else if (fetched.kind === "not_found") {
      // An authoritative "no keys": nothing cached for this actor stays usable.
      this.#entries.delete(actor);
    }
    return fetched;
  }

  /**
   * Resolve `actor`'s (`handle@domain`) active device key for `keyId`, saying
   * why when it does not resolve (see {@link KeyLookup}).
   *
   * An unexpired cached entry holding `keyId` answers without a fetch. With no
   * usable entry, or one lacking `keyId` (the actor may have registered a new
   * device, §4.6), it fetches once. `forceRefresh` always fetches (the
   * middleware does this when a cached key fails to verify). Every fetch goes
   * through the per-actor limiter: it may join one already in flight, or be
   * reported `rate_limited` when the actor was fetched within the interval.
   *
   * An actor that is not canonical `handle@domain` is `refused`: §2.2 — an
   * alias (`a.test:0443`, `Alice@a.test`) never reaches the network.
   */
  async lookupActorKey(
    actor: string,
    keyId: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<KeyLookup<RemoteActorKey>> {
    // A canonical actor is `handle@domain` with a canonical authority.
    if (!isCanonicalActor(actor)) {
      return { kind: "refused", reason: `${actor} is not a canonical actor (§2.2)` };
    }
    const at = actor.lastIndexOf("@");
    const handle = actor.slice(0, at);
    const host = actor.slice(at + 1);
    return lookupKey({
      cached: () => this.#cached(actor),
      refresh: () => this.#limiter.run(actor, () => this.#refresh(actor, handle, host)),
      select: (doc) => selectKey(doc, keyId),
      forceRefresh: opts.forceRefresh ?? false,
    });
  }

  /** Drop a cached actor entry (e.g. on explicit invalidation). */
  invalidate(actor: string): void {
    this.#entries.delete(canonicalActor(actor) ?? actor);
  }
}

/** Pick the matching active key from a keys-response document. */
function selectKey(doc: UserKeysResponse, keyId: string): RemoteActorKey | null {
  const entry = doc.keys.find((k) => k.key_id === keyId);
  if (!entry) return null;
  return { keyId: entry.key_id, publicKey: entry.public_key, algorithm: entry.algorithm };
}
