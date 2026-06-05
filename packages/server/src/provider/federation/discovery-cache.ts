/**
 * Remote provider discovery cache (spec §8.1, §3.1) — resolves another
 * provider's published signing keys so we can verify its provider-signed
 * requests (§8.1) and, later, route federation calls.
 *
 * Behavior:
 *  - {@link RemoteDiscoveryCache.getDocument} fetches
 *    `GET https://{domain}/.well-known/ofscp-provider` through the injected
 *    {@link FederationFetch}, validates it against `ProviderDiscoverySchema`, and
 *    caches it. Subsequent calls reuse the cached copy until its TTL lapses.
 *  - TTL honors the response's HTTP caching headers (`Cache-Control: max-age`,
 *    else `Expires`), bounded by a sane floor/ceiling; falls back to a default
 *    when the peer sets none.
 *  - {@link RemoteDiscoveryCache.getProviderKey} returns the
 *    `provider.publicKeys` entry matching a `key_id` (or `null`). On a cache hit
 *    where the key is **absent**, it re-fetches once (`forceRefresh`) before
 *    giving up — §8.1: "MUST re-fetch on a verification failure for a key_id they
 *    believe should be valid" so key rotation is picked up promptly.
 *
 * The cache is per-app (constructed in `createApp`) and exposed on
 * `c.var.discoveryCache`. It carries no secrets — only public discovery docs.
 */
import {
  type ProviderDiscovery,
  ProviderDiscoverySchema,
  canonicalAuthority,
} from "@forumall/shared";

import { type FederationFetch, defaultFederationFetch, federationGet } from "./http.ts";

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
  /** Lower bound applied to any derived TTL. Default 1_000. */
  readonly minTtlMs?: number;
  /** Upper bound applied to any derived TTL. Default 3_600_000 (1 h). */
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
  readonly doc: ProviderDiscovery;
  /** Epoch ms after which the entry is stale. */
  readonly expiresAt: number;
}

/**
 * Derive a cache TTL (ms) from a discovery response's caching headers, bounded
 * to `[minTtlMs, maxTtlMs]`. Honors `Cache-Control: max-age` first, then
 * `Expires`; otherwise the configured default.
 */
function deriveTtlMs(
  res: Response,
  opts: Required<Pick<DiscoveryCacheOptions, "defaultTtlMs" | "minTtlMs" | "maxTtlMs" | "now">>,
): number {
  const cc = res.headers.get("cache-control");
  if (cc) {
    // `no-store`/`no-cache` → do not reuse (clamp to the floor so we re-fetch).
    if (/\bno-store\b|\bno-cache\b/i.test(cc)) return opts.minTtlMs;
    const m = /max-age\s*=\s*(\d+)/i.exec(cc);
    if (m?.[1]) {
      return clamp(Number(m[1]) * 1000, opts.minTtlMs, opts.maxTtlMs);
    }
  }
  const expires = res.headers.get("expires");
  if (expires) {
    const at = Date.parse(expires);
    if (!Number.isNaN(at)) return clamp(at - opts.now(), opts.minTtlMs, opts.maxTtlMs);
  }
  return clamp(opts.defaultTtlMs, opts.minTtlMs, opts.maxTtlMs);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export class RemoteDiscoveryCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #fetch: FederationFetch;
  readonly #defaultTtlMs: number;
  readonly #minTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #now: () => number;
  /** Total successful network fetches — exposed for tests (cache-hit assertions). */
  #fetchCount = 0;

  constructor(opts: DiscoveryCacheOptions = {}) {
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

  /**
   * Fetch (or return cached) the discovery document for `domain`. With
   * `forceRefresh` the cache entry is ignored and the network is hit.
   *
   * Returns `null` if the document can't be fetched or fails schema validation;
   * any cached copy is left intact on a failed forced refresh.
   */
  async getDocument(
    domain: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<ProviderDiscovery | null> {
    const host = canonicalAuthority(domain);
    if (!opts.forceRefresh) {
      const hit = this.#entries.get(host);
      if (hit && hit.expiresAt > this.#now()) return hit.doc;
    }

    const url = `https://${host}${DISCOVERY_PATH}`;
    let res: Response;
    try {
      res = await federationGet(host, url, {}, this.#fetch);
    } catch {
      return this.#entries.get(host)?.doc ?? null;
    }
    if (!res.ok) return this.#entries.get(host)?.doc ?? null;

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return this.#entries.get(host)?.doc ?? null;
    }
    const result = ProviderDiscoverySchema.safeParse(parsed);
    if (!result.success) return this.#entries.get(host)?.doc ?? null;

    this.#fetchCount += 1;
    const ttl = deriveTtlMs(res, {
      defaultTtlMs: this.#defaultTtlMs,
      minTtlMs: this.#minTtlMs,
      maxTtlMs: this.#maxTtlMs,
      now: this.#now,
    });
    this.#entries.set(host, { doc: result.data, expiresAt: this.#now() + ttl });
    return result.data;
  }

  /**
   * Resolve `domain`'s `provider.publicKeys` entry for `keyId`, or `null`.
   *
   * On a cache hit whose document lacks `keyId`, re-fetches once before giving
   * up (§8.1 rotation rule), unless `forceRefresh` already forced the network.
   */
  async getProviderKey(
    domain: string,
    keyId: string,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<RemoteProviderKey | null> {
    const forced = opts.forceRefresh ?? false;
    const doc = await this.getDocument(domain, { forceRefresh: forced });
    const found = doc ? selectKey(doc, keyId) : null;
    if (found || forced) return found;

    // Key absent from the (possibly cached) document → re-fetch once in case the
    // peer rotated keys since we cached, then look again.
    const refreshed = await this.getDocument(domain, { forceRefresh: true });
    return refreshed ? selectKey(refreshed, keyId) : null;
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
