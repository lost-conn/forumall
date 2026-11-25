/**
 * Shared outcome types + fetch classification for the two remote-key caches
 * ({@link RemoteUserKeysCache} §4.6, {@link RemoteDiscoveryCache} §8.1).
 *
 * A verifier must know WHY a key could not be resolved, because §4.5 step 6
 * answers differently for each reason (§4.6 "The outcome of a fetch is
 * classified as follows", §8.1 last paragraph):
 *
 *  - `found`        — a key with the requested `key_id`, from an UNEXPIRED cache
 *                     entry or a fetch just made (`fresh`).
 *  - `no_key`       — a completed fetch shows there is no such key: a valid
 *                     `200` document without it (or, for user keys, a `404`)
 *                     → `401`.
 *  - `fetch_failed` — the document could not be obtained: a network error,
 *                     DNS failure, timeout, `3xx`, `429`, `5xx`, any other
 *                     non-success answer, or an invalid body → `503`.
 *  - `refused`      — the outbound-request rules (§8 "Outbound requests")
 *                     forbid the fetch → `401` (never `503`: retrying cannot
 *                     help).
 *  - `rate_limited` — a fetch was needed but the per-identity limit
 *                     ({@link RefetchLimiter}) suppressed it, and no unexpired
 *                     cached key matches → `503` + `Retry-After` (§4.6, §8.1).
 *
 * Federation-policy denial (§8 Authorization → `403`) is NOT an outcome here:
 * the verifier decides it from the claimed domain before calling a cache.
 *
 * Expiry rule (§4.6, PR #20): only an unexpired cache entry ever counts. A
 * cache answers from an unexpired entry that holds the key without fetching;
 * otherwise it fetches and reports the fetch's own outcome. It never falls back
 * to cached data after a failed fetch — an unexpired entry holding the key
 * would have been used before fetching, and an expired one must not be used.
 */
import { EgressBlockedError } from "./egress-guard.ts";
import { type FederationFetch, federationGet } from "./http.ts";
import type { RateLimited, RefetchLimiter } from "./refetch-limiter.ts";

/** Why (or whether) a remote signing key resolved. See the module docs. */
export type KeyLookup<K> =
  | { readonly kind: "found"; readonly key: K; readonly fresh: boolean }
  | { readonly kind: "no_key" }
  | { readonly kind: "fetch_failed"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | RateLimited;

/** The result of one network fetch of a key document. */
export type DocumentFetch<D> =
  | { readonly kind: "ok"; readonly doc: D; readonly response: Response }
  /** A `404` that the endpoint's rules say means "no keys" (§4.6 user keys). */
  | { readonly kind: "not_found" }
  | { readonly kind: "fetch_failed"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

/** How to fetch and validate one kind of key document. */
export interface DocumentFetchSpec<D> {
  /** The canonical authority the request is addressed to. */
  readonly host: string;
  readonly url: string;
  /** True when a `404` means "no keys" (user keys, §4.6); false makes it a fetch failure (§8.1). */
  readonly notFoundMeansNoKeys: boolean;
  /**
   * Validate a parsed JSON body: the document, or a reason it is invalid
   * (schema mismatch, or a document naming a different actor/provider).
   */
  readonly validate: (body: unknown) => { ok: true; doc: D } | { ok: false; reason: string };
}

/**
 * Perform one GET of a key document and classify the result. Only a `200`
 * with a valid body is `ok` (§4.6, §8.1); an {@link EgressBlockedError} from
 * the transport is `refused`; every other failure is `fetch_failed`.
 */
export async function fetchKeyDocument<D>(
  federationFetch: FederationFetch,
  spec: DocumentFetchSpec<D>,
): Promise<DocumentFetch<D>> {
  let res: Response;
  try {
    res = await federationGet(spec.host, spec.url, {}, federationFetch);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof EgressBlockedError) return { kind: "refused", reason };
    return { kind: "fetch_failed", reason };
  }
  if (res.status === 404 && spec.notFoundMeansNoKeys) {
    await res.body?.cancel();
    return { kind: "not_found" };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return { kind: "fetch_failed", reason: `${spec.url} answered ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    // Not JSON — or the deadline expired while reading the body.
    const why = err instanceof Error ? err.message : String(err);
    return { kind: "fetch_failed", reason: `${spec.url} body unreadable: ${why}` };
  }
  const checked = spec.validate(body);
  if (!checked.ok) return { kind: "fetch_failed", reason: checked.reason };
  return { kind: "ok", doc: checked.doc, response: res };
}

/**
 * The lookup flow both caches share. Without `forceRefresh`, an unexpired
 * cached document that holds the key answers without a fetch; otherwise (no
 * entry, an expired one, the key absent — §4.6 "re-fetch before finally
 * rejecting" — or a forced refresh) `refresh` fetches once and its outcome is
 * reported as is. `refresh` goes through the cache's {@link RefetchLimiter},
 * so it may instead join a fetch already in flight or be `rate_limited`.
 */
export async function lookupKey<D, K>(args: {
  /** The unexpired cached document, if any. */
  readonly cached: () => D | null;
  /** Fetch (and, on success, cache) the document, subject to the limiter. */
  readonly refresh: () => Promise<DocumentFetch<D> | RateLimited>;
  readonly select: (doc: D) => K | null;
  readonly forceRefresh: boolean;
}): Promise<KeyLookup<K>> {
  if (!args.forceRefresh) {
    const doc = args.cached();
    const key = doc ? args.select(doc) : null;
    if (key) return { kind: "found", key, fresh: false };
  }
  const fetched = await args.refresh();
  switch (fetched.kind) {
    case "ok": {
      const key = args.select(fetched.doc);
      return key ? { kind: "found", key, fresh: true } : { kind: "no_key" };
    }
    case "not_found":
      return { kind: "no_key" };
    default:
      return fetched;
  }
}
