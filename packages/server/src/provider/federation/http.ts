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
 * Default {@link FederationFetch}: perform the request as-is over the global
 * `fetch` (the URL is already `https://{domain}/...`).
 */
export const defaultFederationFetch: FederationFetch = (_domain, request) => fetch(request);

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
}

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
  const key = getProviderSigningKey(db);
  const { domain, authority, path, query } = targetParts(init.url);
  const body = init.body ?? new Uint8Array(0);

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
  const request = new Request(init.url, requestInit);

  return federationFetch(domain, request);
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
