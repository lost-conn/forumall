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
 *  - The actor is chosen by the requester, so the per-actor limit alone does
 *    not protect the actor's home provider from a stream of random handles
 *    (`r1@victim.example`, `r2@victim.example`, …). Every NEW fetch is also
 *    admitted by a per-host {@link HostFetchLimiter} keyed by the canonical
 *    authority contacted (token bucket + in-flight cap, `hostFetchLimits`,
 *    defaults `DEFAULT_HOST_FETCH_LIMITS`); a fetch it refuses is
 *    `rate_limited` with the host's wait, exactly like the per-actor case.
 *
 *  - Memory is bounded: cached documents by {@link ExpiringEntries} (expired
 *    ones removed, at most `maxCachedDocuments`, least recently used evicted),
 *    each document's body by `maxDocumentBytes`, and the record of last
 *    completed fetches by `maxRememberedFetches`. Actors are named by
 *    requesters, so none of these may grow with them.
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

import {
  DEFAULT_MAX_CACHED_DOCUMENTS,
  ExpiringEntries,
  requireCountAtLeastOne,
} from "./expiring-entries.ts";
import { HostFetchLimiter, type HostFetchLimits } from "./host-fetch-limiter.ts";
import { type FederationFetch, defaultFederationFetch } from "./http.ts";
import {
  type CachedDocument,
  DEFAULT_MAX_KEY_DOCUMENT_BYTES,
  type DocumentFetch,
  type KeyLookup,
  fetchKeyDocument,
  lookupKey,
} from "./key-lookup.ts";
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
  /**
   * Per-host bound on the fetches above (§8 Outbound requests), overriding any
   * of `DEFAULT_HOST_FETCH_LIMITS`: `burst` back to back, then
   * `refillPerSecond`; at most `maxInFlight` at once; `maxHosts` tracked.
   */
  readonly hostFetchLimits?: Partial<HostFetchLimits>;
  /**
   * How many actors' last completed fetch ({@link RemoteUserKeysCache.lastCompletedFetch})
   * are remembered; the least recently fetched is forgotten first. Default
   * {@link DEFAULT_MAX_REMEMBERED_FETCHES}. Integer ≥ 1.
   */
  readonly maxRememberedFetches?: number;
  /**
   * How many documents are cached at most; past it the least recently used is
   * evicted (it is simply fetched again when next needed). Expired entries are
   * removed too. Default {@link DEFAULT_MAX_CACHED_DOCUMENTS}. Integer ≥ 1.
   */
  readonly maxCachedDocuments?: number;
  /**
   * Largest response body read, in bytes; a larger one is a fetch failure.
   * Default {@link DEFAULT_MAX_KEY_DOCUMENT_BYTES}. Integer ≥ 1.
   */
  readonly maxDocumentBytes?: number;
  /** Injected transport (default: the egress-guarded {@link defaultFederationFetch}). */
  readonly federationFetch?: FederationFetch;
  /** Clock, overridable in tests. Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 300_000;

/**
 * Default cap on remembered last fetches. Actors are named by requesters, so
 * the record must be bounded; forgetting one only loses evidence (§7.1 then
 * falls back to the connection's own lookups and its entry's expiry — it never
 * keeps a key alive longer).
 */
export const DEFAULT_MAX_REMEMBERED_FETCHES = 10_000;
const MAX_TTL_MS = 3_600_000;

export class RemoteUserKeysCache {
  /** Unexpired documents per actor, bounded (see {@link ExpiringEntries}). */
  readonly #entries: ExpiringEntries<UserKeysResponse>;
  readonly #maxDocumentBytes: number;
  /**
   * Per actor, what the most recent COMPLETED fetch showed: its document, or
   * `null` for a `404`. Kept even when the document was not cacheable, because
   * it is still evidence (§7.1: "a completed fetch shows the key is no longer
   * published"). See {@link lastCompletedFetch}. Bounded by
   * `#maxRememberedFetches`, oldest fetch forgotten first (Map insertion order;
   * {@link #rememberFetch} re-inserts on every fetch).
   */
  readonly #lastFetch = new Map<string, UserKeysResponse | null>();
  readonly #maxRememberedFetches: number;
  readonly #fetch: FederationFetch;
  readonly #defaultTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #now: () => number;
  readonly #limiter: RefetchLimiter<DocumentFetch<UserKeysResponse>>;
  readonly #hostLimiter: HostFetchLimiter;
  /** Total successful network fetches — exposed for tests (cache-hit assertions). */
  #fetchCount = 0;

  constructor(opts: UserKeysCacheOptions = {}) {
    this.#fetch = opts.federationFetch ?? defaultFederationFetch;
    this.#defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#maxTtlMs = opts.maxTtlMs ?? MAX_TTL_MS;
    this.#now = opts.now ?? Date.now;
    this.#maxRememberedFetches = opts.maxRememberedFetches ?? DEFAULT_MAX_REMEMBERED_FETCHES;
    requireCountAtLeastOne("maxRememberedFetches", this.#maxRememberedFetches);
    this.#maxDocumentBytes = opts.maxDocumentBytes ?? DEFAULT_MAX_KEY_DOCUMENT_BYTES;
    requireCountAtLeastOne("maxDocumentBytes", this.#maxDocumentBytes);
    const maxCachedDocuments = opts.maxCachedDocuments ?? DEFAULT_MAX_CACHED_DOCUMENTS;
    requireCountAtLeastOne("maxCachedDocuments", maxCachedDocuments);
    this.#entries = new ExpiringEntries({ maxEntries: maxCachedDocuments, now: this.#now });
    this.#limiter = new RefetchLimiter({
      intervalMs: opts.refetchIntervalMs ?? DEFAULT_REFETCH_INTERVAL_MS,
      now: this.#now,
    });
    this.#hostLimiter = new HostFetchLimiter({
      ...(opts.hostFetchLimits ? { limits: opts.hostFetchLimits } : {}),
      now: this.#now,
    });
  }

  /** Successful network fetches so far (cache misses + forced refetches). */
  get fetchCount(): number {
    return this.#fetchCount;
  }

  /**
   * The cache's clock (epoch ms) — the clock a `found` lookup's `expiresAt` is
   * on. §7.1 re-resolution compares a connection's key expiry against it.
   */
  now(): number {
    return this.#now();
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

  /** The unexpired cache entry for `actor`, if any. */
  #cached(actor: string): CachedDocument<UserKeysResponse> | null {
    return this.#entries.get(actor);
  }

  /** Record `actor`'s latest completed fetch, forgetting the oldest beyond the cap. */
  #rememberFetch(actor: string, doc: UserKeysResponse | null): void {
    this.#lastFetch.delete(actor);
    this.#lastFetch.set(actor, doc);
    while (this.#lastFetch.size > this.#maxRememberedFetches) {
      const oldest = this.#lastFetch.keys().next().value;
      if (oldest === undefined) break;
      this.#lastFetch.delete(oldest);
    }
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
      maxBodyBytes: this.#maxDocumentBytes,
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
      this.#rememberFetch(actor, fetched.doc);
      const ttl = this.#ttlMs(fetched.doc);
      if (ttl > 0) {
        this.#entries.set(actor, fetched.doc, this.#now() + ttl);
      } else {
        this.#entries.delete(actor);
      }
    } else if (fetched.kind === "not_found") {
      // An authoritative "no keys": nothing cached for this actor stays usable.
      this.#entries.delete(actor);
      this.#rememberFetch(actor, null);
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
   * reported `rate_limited` when the actor was fetched within the interval or
   * when the actor's host has used up its per-host allowance.
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
      refresh: () =>
        this.#limiter.run(
          actor,
          () => this.#refresh(actor, handle, host),
          () => this.#hostLimiter.tryStart(host),
        ),
      select: (doc) => selectKey(doc, keyId),
      forceRefresh: opts.forceRefresh ?? false,
    });
  }

  /**
   * What the most recent completed fetch of `actor`'s keys (by anyone: a REST
   * verify, a handshake, a WS re-check) showed for `keyId`, without fetching:
   * the key (`null` when that fetch did not publish it, including a `404`) and,
   * when that fetch's document is still the unexpired cache entry, the entry's
   * expiry (cache clock); otherwise `expiresAt` is `null`. `null` overall when
   * no fetch of the actor has completed. §7.1 re-resolution uses it so that a
   * fetch made for another reason refreshes — or ends — a connection's key.
   */
  lastCompletedFetch(
    actor: string,
    keyId: string,
  ): { readonly key: RemoteActorKey | null; readonly expiresAt: number | null } | null {
    const doc = this.#lastFetch.get(actor);
    if (doc === undefined) return null;
    const entry = this.#cached(actor);
    return {
      key: doc ? selectKey(doc, keyId) : null,
      expiresAt: entry && entry.doc === doc ? entry.expiresAt : null,
    };
  }

  /** Drop what is known about an actor's keys (e.g. on explicit invalidation). */
  invalidate(actor: string): void {
    const key = canonicalActor(actor) ?? actor;
    this.#entries.delete(key);
    this.#lastFetch.delete(key);
  }
}

/** Pick the matching active key from a keys-response document. */
function selectKey(doc: UserKeysResponse, keyId: string): RemoteActorKey | null {
  const entry = doc.keys.find((k) => k.key_id === keyId);
  if (!entry) return null;
  return { keyId: entry.key_id, publicKey: entry.public_key, algorithm: entry.algorithm };
}
