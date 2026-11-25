/**
 * Remote provider discovery cache (spec §8.1, §3.1) — resolves another
 * provider's published signing keys so we can verify its provider-signed
 * requests (§8.1).
 *
 * Behavior:
 *  - Fetches `GET https://{domain}/.well-known/ofscp-provider` through the
 *    injected {@link FederationFetch}. Only a `200` whose body matches
 *    `ProviderDiscoverySchema` AND whose `provider.domain`, canonicalized
 *    (§2.2), equals the authority it was fetched from is valid (§3.1, §8.1);
 *    anything else — including a `404` — is a fetch failure.
 *  - An entry is valid for as long as the response's HTTP caching headers
 *    allow it to be used without revalidation (`Cache-Control: max-age`, else
 *    `Expires`; `no-store`/`no-cache` → not at all), capped at `maxTtlMs`, or
 *    for a default when the peer sets none. An expired entry is never used —
 *    not even when a re-fetch fails (§8.1, `key-lookup.ts`).
 *  - {@link RemoteDiscoveryCache.lookupProviderKey} reports a
 *    {@link KeyLookup}: an unexpired entry holding the key answers without a
 *    fetch; otherwise (no entry, key absent — §8.1 "MUST re-fetch on a
 *    verification failure for a key_id they believe should be valid" — or
 *    `forceRefresh`) it fetches once and reports why the key did or did not
 *    resolve.
 *
 * The cache is per-app (constructed in `createApp`) and exposed on
 * `c.var.discoveryCache`. It carries no secrets — only public discovery docs.
 */
import {
  type ProviderDiscovery,
  ProviderDiscoverySchema,
  canonicalAuthority,
  isCanonicalAuthority,
} from "@forumall/shared";

import { type FederationFetch, defaultFederationFetch } from "./http.ts";
import { type DocumentFetch, type KeyLookup, fetchKeyDocument, lookupKey } from "./key-lookup.ts";

/** The well-known discovery path (§3.1). */
const DISCOVERY_PATH = "/.well-known/ofscp-provider";

/** A published provider signing key (the verify target). */
export interface RemoteProviderKey {
  readonly keyId: string;
  /** Base64 raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  readonly algorithm: string;
}

/** Tunables for the cache TTL derivation (all ms). */
export interface DiscoveryCacheOptions {
  /** TTL when the peer sets no usable cache header. Default 300_000 (5 min). */
  readonly defaultTtlMs?: number;
  /** Upper bound applied to any derived TTL. Default 3_600_000 (1 h). */
  readonly maxTtlMs?: number;
  /** Injected transport (default: the egress-guarded {@link defaultFederationFetch}). */
  readonly federationFetch?: FederationFetch;
  /** Clock, overridable in tests. Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 300_000;
const MAX_TTL_MS = 3_600_000;

interface CacheEntry {
  readonly doc: ProviderDiscovery;
  /** Epoch ms after which the entry is stale. */
  readonly expiresAt: number;
}

/**
 * How long (ms) a discovery response may be used without revalidation, per its
 * HTTP caching headers: `Cache-Control: no-store`/`no-cache` → 0, else
 * `max-age`, else `Expires`, else the configured default — capped at
 * `maxTtlMs`. ≤ 0 means "do not cache" (§8.1: an entry the headers no longer
 * allow to be used without revalidation is expired).
 */
function deriveTtlMs(
  res: Response,
  opts: { defaultTtlMs: number; maxTtlMs: number; now: () => number },
): number {
  const cc = res.headers.get("cache-control");
  if (cc) {
    if (/\bno-store\b|\bno-cache\b/i.test(cc)) return 0;
    const m = /max-age\s*=\s*(\d+)/i.exec(cc);
    if (m?.[1]) return Math.min(Number(m[1]) * 1000, opts.maxTtlMs);
  }
  const expires = res.headers.get("expires");
  if (expires) {
    const at = Date.parse(expires);
    // RFC 9111: an invalid Expires (e.g. "0") means already expired.
    return Number.isNaN(at) ? 0 : Math.min(at - opts.now(), opts.maxTtlMs);
  }
  return Math.min(opts.defaultTtlMs, opts.maxTtlMs);
}

export class RemoteDiscoveryCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #fetch: FederationFetch;
  readonly #defaultTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #now: () => number;
  /** Total successful network fetches — exposed for tests (cache-hit assertions). */
  #fetchCount = 0;

  constructor(opts: DiscoveryCacheOptions = {}) {
    this.#fetch = opts.federationFetch ?? defaultFederationFetch;
    this.#defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.#maxTtlMs = opts.maxTtlMs ?? MAX_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** Successful network fetches so far (cache misses + forced refetches). */
  get fetchCount(): number {
    return this.#fetchCount;
  }

  /** The unexpired cached document for `host`, if any. */
  #cached(host: string): ProviderDiscovery | null {
    const hit = this.#entries.get(host);
    return hit && hit.expiresAt > this.#now() ? hit.doc : null;
  }

  /** Fetch `host`'s discovery document once; cache it on success. */
  async #refresh(host: string): Promise<DocumentFetch<ProviderDiscovery>> {
    const fetched = await fetchKeyDocument<ProviderDiscovery>(this.#fetch, {
      host,
      url: `https://${host}${DISCOVERY_PATH}`,
      notFoundMeansNoKeys: false,
      validate: (body) => {
        const parsed = ProviderDiscoverySchema.safeParse(body);
        if (!parsed.success) return { ok: false, reason: `invalid discovery document for ${host}` };
        // §3.1/§8.1: a document for another provider is not a valid document.
        if (canonicalAuthority(parsed.data.provider.domain) !== host) {
          return {
            ok: false,
            reason: `discovery document from ${host} names ${parsed.data.provider.domain}`,
          };
        }
        return { ok: true, doc: parsed.data };
      },
    });
    if (fetched.kind === "ok") {
      this.#fetchCount += 1;
      const ttl = deriveTtlMs(fetched.response, {
        defaultTtlMs: this.#defaultTtlMs,
        maxTtlMs: this.#maxTtlMs,
        now: this.#now,
      });
      if (ttl > 0) {
        this.#entries.set(host, { doc: fetched.doc, expiresAt: this.#now() + ttl });
      } else {
        this.#entries.delete(host);
      }
    }
    return fetched;
  }

  /**
   * Resolve `domain`'s `provider.publicKeys` entry for `keyId`, saying why when
   * it does not resolve (see {@link KeyLookup}).
   *
   * An unexpired cached document holding `keyId` answers without a fetch. With
   * no usable entry, or one lacking `keyId` (the peer may have rotated, §8.1),
   * it fetches once. `forceRefresh` always fetches (the middleware does this
   * when a cached key fails to verify). A domain that does not canonicalize to
   * a bare host[:port] (§2.2) is `refused` and never fetched.
   */
  async lookupProviderKey(
    domain: string,
    keyId: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<KeyLookup<RemoteProviderKey>> {
    const host = canonicalAuthority(domain);
    if (!isCanonicalAuthority(host)) {
      return { kind: "refused", reason: `${domain} is not a canonical authority (§2.2)` };
    }
    return lookupKey({
      cached: () => this.#cached(host),
      refresh: () => this.#refresh(host),
      select: (doc) => selectKey(doc, keyId),
      forceRefresh: opts.forceRefresh ?? false,
    });
  }

  /** Drop a cached entry (e.g. on shutdown or explicit invalidation). */
  invalidate(domain: string): void {
    this.#entries.delete(canonicalAuthority(domain));
  }
}

/** Pick the matching published key from a discovery document. */
function selectKey(doc: ProviderDiscovery, keyId: string): RemoteProviderKey | null {
  const entry = doc.provider.publicKeys.find((k) => k.key_id === keyId);
  if (!entry) return null;
  return { keyId: entry.key_id, publicKey: entry.public_key, algorithm: entry.algorithm };
}
