/**
 * Federation HTTP client (spec §8) — the single outbound door for every
 * provider-to-provider call.
 *
 * Two concerns live here, both reusable by the later P7 cards (remote actor key
 * resolution, remote channel join, notification delivery):
 *
 *  1. {@link FederationFetch} — an **injectable** fetch. The default routes a
 *     request for domain `d` to `https://{d}/...` via the global `fetch`. Tests
 *     (and any environment that maps domains differently) inject a custom one
 *     that points, say, `b.test` at `http://localhost:{portB}` while keeping the
 *     real domain as the authority/Host, so signatures still verify against the
 *     peer's `config.domain`.
 *
 *  2. {@link signedProviderFetch} — attach §8.1 provider-signed headers to an
 *     outbound request. It builds the §4.4.2 canonical string for the *target*
 *     URL (authority = target host, method, path, query, timestamp, nonce,
 *     content-digest of the body) and signs it with this provider's signing key
 *     (`getProviderSigningKey`) via the shared `signProvider`.
 *
 * ## Injection point
 * `createApp(config, { ..., federationFetch })` threads a {@link FederationFetch}
 * into `c.var.federationFetch`. Anything needing to call a peer reads it from
 * there (or accepts it as an argument). Production passes nothing → the global-
 * `fetch` default; the two-provider test harness passes a domain→port router.
 */
import { HEADER, type ProviderSignInput, contentDigest, signProvider } from "@forumall/shared";

import type { Config } from "../../config.ts";
import type { Db } from "../../db/index.ts";
import { getProviderSigningKey } from "../signing-key.ts";
import { guardedFetch } from "./egress-guard.ts";
import { isProviderAllowed } from "./policy.ts";

/**
 * An injectable fetch keyed by the *logical* target domain.
 *
 * `domain` is the OFSCP provider domain (e.g. `b.test`) — the authority the
 * request is addressed to and signed for. `request` is a ready-to-send
 * {@link Request} whose URL already encodes that domain as `https://{domain}/...`.
 *
 * The default ({@link defaultFederationFetch}) simply performs the request. A
 * test fetcher rewrites the URL's origin to the peer's localhost port while
 * **preserving the `Host` header / authority** so the peer verifies the
 * signature against its own `config.domain`.
 */
export type FederationFetch = (domain: string, request: Request) => Promise<Response>;

/**
 * Default {@link FederationFetch}: perform the request over the egress guard
 * (`egress-guard.ts`) — public https hosts only, no redirects followed, bounded
 * by a timeout. Every peer domain reaching here was named by someone else (an
 * `X-OFSCP-Actor` header, a peer list, a webhook target), so it must never be
 * able to steer the provider at loopback, metadata or internal addresses.
 */
export const defaultFederationFetch: FederationFetch = (_domain, request) => guardedFetch(request);

/**
 * Wrap a {@link FederationFetch} so it refuses — without touching the network —
 * every request to a provider the §8 allow/deny policy denies.
 *
 * §8 "Authorization" forbids sending ANY outbound request to a denied provider:
 * signed or unsigned, on our own behalf or forwarded for a user (DM delivery,
 * reactions, edits, deletes, notification delivery), key (§4.6) and discovery
 * (§3.1) fetches included — whatever stored state names it. `createApp` wraps
 * its transport with this, so every caller that reaches a peer through
 * `c.var.federationFetch` or the app's discovery/user-keys caches passes this
 * one door. Both the logical `domain` and the request URL's authority are
 * checked, each after {@link isProviderAllowed}'s canonicalization (§2.2), so
 * `evil.example.` or `EVIL.example:443` cannot slip past a deny of
 * `evil.example`. A refusal is answered like a refusing peer (`403`) so
 * callers' existing `!res.ok` handling applies.
 */
export function withFederationPolicy(config: Config, inner: FederationFetch): FederationFetch {
  return (domain, request) => {
    let urlAuthority: string;
    try {
      urlAuthority = new URL(request.url).host;
    } catch {
      return Promise.resolve(policyRefusal());
    }
    if (!isProviderAllowed(config, domain) || !isProviderAllowed(config, urlAuthority)) {
      return Promise.resolve(policyRefusal());
    }
    return inner(domain, request);
  };
}

/** The synthetic response for a request the federation policy refused. */
function policyRefusal(): Response {
  return new Response(null, { status: 403, statusText: "federation policy" });
}

/** True for a loopback host (`localhost`, `127.0.0.1`, `[::1]`), port-agnostic. */
function isLoopbackHost(host: string): boolean {
  // `host` may carry a port (e.g. `localhost:8787`); strip it before matching.
  const bracket = host.startsWith("[") ? host.indexOf("]") : -1;
  const hostname = bracket >= 0 ? host.slice(1, bracket) : (host.split(":")[0] ?? host);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Insecure-localhost {@link FederationFetch} (dev / self-host / testing only,
 * gated behind `FEDERATION_INSECURE_LOCALHOST`).
 *
 * Federation always *addresses* a peer as `https://{domain}/...` (the discovery /
 * user-keys caches and `signedProviderFetch` build https URLs). In a loopback
 * dev/test topology the peer is a plain-http server bound to `localhost:<port>`,
 * so this transport rewrites the scheme to `http` **only when the target host is
 * loopback** — every non-loopback target still goes out over TLS unchanged. The
 * request's authority/`Host` (and the signing authority baked into the
 * `X-OFSCP-*` headers) are untouched, so the peer verifies the signature against
 * its own `config.domain` exactly as in production.
 *
 * This is what lets the two-provider browser harness — where each provider's
 * `DOMAIN` is `localhost:<port>` over http — resolve a peer's §4.6 user-keys and
 * §3.1 discovery over loopback. Production (default OFF) never reaches here.
 */
export const insecureLocalhostFederationFetch: FederationFetch = (_domain, request) => {
  const url = new URL(request.url);
  if (url.protocol === "https:" && isLoopbackHost(url.host)) {
    url.protocol = "http:";
    // Preserve method/body/headers (incl. the X-OFSCP-* signing headers + Host).
    return fetch(new Request(url.toString(), request));
  }
  // Non-loopback targets get the same egress guard as production.
  return guardedFetch(request);
};

/** Split a target URL into the pieces the canonical string needs. */
function targetParts(url: string): {
  domain: string;
  authority: string;
  path: string;
  query: string;
} {
  const u = new URL(url);
  // `u.host` includes a non-default port; `u.hostname` omits it. The canonical
  // authority (built by signProvider) strips :443, so passing host is correct.
  const path = u.pathname === "" ? "/" : u.pathname;
  const query = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  return { domain: u.hostname, authority: u.host, path, query };
}

/** A single outbound provider-signed request. */
export interface SignedProviderFetchInit {
  /** HTTP method, e.g. `POST`. */
  readonly method: string;
  /** Absolute target URL, `https://{domain}{path}?{query}`. */
  readonly url: string;
  /** Optional request body (string or bytes). Empty when omitted. */
  readonly body?: string | Uint8Array;
  /** Extra non-signing headers (e.g. `content-type`). */
  readonly headers?: Record<string, string>;
  /** Override timestamp/nonce (tests/replay control); defaults applied by `signProvider`. */
  readonly timestamp?: string;
  readonly nonce?: string;
  /**
   * Retry a `503` that carries `Retry-After` — e.g. a peer in its §4.5
   * replay-store warm-up after a restart — RE-SIGNING each attempt with a fresh
   * timestamp + nonce (resending the same signed request can never succeed).
   * Omit for no retry. See {@link Retry503Policy} for when it is safe to set.
   */
  readonly retry?: Retry503Policy;
}

/**
 * Bounded retry-on-503 policy for {@link signedProviderFetch}.
 *
 * **When to set it.** Only for requests that are safe to deliver twice: an
 * idempotent method (GET/HEAD/PUT/DELETE), or a request whose body carries an
 * idempotency key the peer dedupes on (e.g. an edit that REPLACES content, a
 * notification identified by its event + resource). A §4.5 warm-up `503` is
 * sent before the peer processes anything, but a 503 from some other component
 * might not be, so non-idempotent requests MUST NOT opt in.
 *
 * **Behaviour.** Only a `503` with a parseable `Retry-After` (delta-seconds or
 * HTTP-date) is retried, after waiting exactly that long; the request is
 * re-signed each time. It gives up — returning the last `503` to the caller —
 * once the next wait would push the total past `maxTotalWaitMs`, or after
 * `maxAttempts` attempts. Requests with a caller-pinned `timestamp`/`nonce` are
 * never retried (they could not be re-signed fresh).
 */
export interface Retry503Policy {
  /** Cap on the summed `Retry-After` waits, ms. */
  readonly maxTotalWaitMs: number;
  /** Cap on total attempts (first try included). Default 4. */
  readonly maxAttempts?: number;
  /** Injectable sleep (tests). Default: a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for HTTP-date `Retry-After` (tests). Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Background sends nobody is waiting on (§10 notification delivery): long
 * enough to ride out a peer's full §4.5 warm-up (300s) plus slack.
 */
export const BACKGROUND_RETRY: Retry503Policy = { maxTotalWaitMs: 360_000 };

/**
 * Sends made inline while a user's own request waits (DM edit/delete/reaction
 * forwards, §8.3): a short wait only. A longer warm-up 503 is relayed to the
 * user's client WITH its `Retry-After`, and the client decides (the web client
 * retries briefly, then shows a clear "provider restarting" message).
 */
export const INLINE_RETRY: Retry503Policy = { maxTotalWaitMs: 10_000 };

/**
 * Parse a `Retry-After` value (RFC 9110 §10.2.3: delta-seconds or HTTP-date)
 * into milliseconds from `now`, or `null` when absent/unparseable.
 */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Perform an outbound **provider-signed** (§8.1) request to another provider.
 *
 * Signs the §4.4.2 canonical string for `url` with this provider's signing key
 * and sends `X-OFSCP-Provider` + the other `X-OFSCP-*` headers, routed through
 * the injected {@link FederationFetch} (default: global `fetch`).
 *
 * The signing authority is the **target** host (so the peer, which binds its own
 * `config.domain` as the authority, verifies it). The `X-OFSCP-Provider` value
 * is *this* provider's `config.domain` — the identity being asserted.
 */
export async function signedProviderFetch(
  db: Db,
  config: Config,
  init: SignedProviderFetchInit,
  federationFetch: FederationFetch = defaultFederationFetch,
): Promise<Response> {
  const { domain, authority, path, query } = targetParts(init.url);
  // Deny wins outbound too (§8): never sign a request to a provider the policy
  // blocks, whatever stored row named it. Answer like a refusing peer so
  // callers' existing `!res.ok` handling applies.
  if (!isProviderAllowed(config, domain) || !isProviderAllowed(config, authority)) {
    return policyRefusal();
  }
  const key = getProviderSigningKey(db);
  const body = init.body ?? new Uint8Array(0);

  // Build + sign one attempt. Called afresh per attempt so a retry carries a new
  // timestamp + nonce (§4.5: a re-sent signed request can never succeed).
  const attempt = (): Promise<Response> => {
    const signInput: ProviderSignInput = {
      provider: config.domain,
      keyId: key.keyId,
      privateKey: key.privateKey,
      authority,
      method: init.method,
      path,
      query,
      body,
      ...(init.timestamp !== undefined ? { timestamp: init.timestamp } : {}),
      ...(init.nonce !== undefined ? { nonce: init.nonce } : {}),
    };
    const { headers: signed } = signProvider(signInput);

    const requestInit: RequestInit = {
      method: init.method,
      headers: { ...init.headers, ...signed },
    };
    if (!isEmptyBody(body)) {
      // BodyInit accepts string and BufferSource (incl. Uint8Array).
      requestInit.body = body as BodyInit;
    }
    return federationFetch(domain, new Request(init.url, requestInit));
  };

  const policy = init.retry;
  if (policy === undefined || init.timestamp !== undefined || init.nonce !== undefined) {
    return attempt();
  }
  const sleep = policy.sleep ?? realSleep;
  const now = policy.now ?? Date.now;
  const maxAttempts = policy.maxAttempts ?? 4;
  let waited = 0;
  for (let n = 1; ; n++) {
    const res = await attempt();
    if (res.status !== 503 || n >= maxAttempts) return res;
    const waitMs = parseRetryAfterMs(res.headers.get("retry-after"), now());
    if (waitMs === null || waited + waitMs > policy.maxTotalWaitMs) return res;
    await res.body?.cancel(); // discard this attempt's body before waiting
    await sleep(waitMs);
    waited += waitMs;
  }
}

function isEmptyBody(body: string | Uint8Array): boolean {
  return typeof body === "string" ? body.length === 0 : body.byteLength === 0;
}

/**
 * Plain (unsigned) federation GET — used by discovery fetching, where the
 * `.well-known` document is public and unsigned. Routed through the same
 * injected {@link FederationFetch} so tests can reach in-process peers.
 */
export async function federationGet(
  domain: string,
  url: string,
  init: { headers?: Record<string, string> } = {},
  federationFetch: FederationFetch = defaultFederationFetch,
): Promise<Response> {
  const request = new Request(url, {
    method: "GET",
    ...(init.headers ? { headers: init.headers } : {}),
  });
  return federationFetch(domain, request);
}

/** Re-export so consumers can reference the canonical header names. */
export { HEADER, contentDigest };
