import { HEADER } from "@forumall/shared";
/**
 * Cross-origin (CORS) middleware for the cross-provider browser client (§4 / §8).
 *
 * OFSCP authenticates every request by an **Ed25519 signature** over the §4.4.2
 * canonical string (the `X-OFSCP-*` headers) — never by cookies, a session, or
 * the request Origin. A user's browser, served by their HOME provider, signs
 * requests addressed to a DIFFERENT provider (DM delivery to the recipient's
 * provider §7.4, a contact mirror §6.7, a remote channel join §8.2, a remote
 * §4.6 key/discovery read) and sends them cross-origin. The Same-Origin Policy
 * would block those without CORS response headers.
 *
 * Because the credential is the signature (not ambient browser state), echoing
 * `Access-Control-Allow-Origin: *` is safe here: there is nothing origin-scoped to
 * leak (no cookies are read, and the server NEVER trusts the Origin/Host — the
 * §4.5 verifier binds its own `config.domain` as the authority, so a forged
 * Origin changes nothing). We do NOT set `Allow-Credentials` (no cookies), keeping
 * the wildcard origin valid per the Fetch spec. The exposed/allowed headers are
 * exactly the OFSCP signing headers plus the few transport headers the client
 * uses; a preflight `OPTIONS` short-circuits with a 204 (§3.4).
 *
 * The same headers are sent on every path, including the provider's own
 * non-standard endpoints: §3.4 allows that, and none of them relies on ambient
 * authority (the admin API is signature-authed too). WebSocket upgrades are
 * never checked against `Origin` (§3.4/§7.1): the signed `authenticate`
 * handshake is the access control.
 */
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "./types.ts";

/** Request/response headers the cross-provider client sends + reads. */
const OFSCP_HEADERS = [
  HEADER.ACTOR,
  HEADER.PROVIDER,
  HEADER.KEY_ID,
  HEADER.TIMESTAMP,
  HEADER.NONCE,
  HEADER.CONTENT_DIGEST,
  HEADER.SIGNATURE,
  "content-type",
  "authorization",
  "accept",
].join(", ");

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/**
 * Response headers a cross-origin browser client may read: the OFSCP set plus
 * `Retry-After` (429/503 backoff) and `ETag` (discovery/keys caching).
 */
const EXPOSE_HEADERS = `${OFSCP_HEADERS}, retry-after, etag`;

/**
 * Permissive, credential-less CORS for the API + cross-provider well-known reads.
 * Applied app-wide before routing; a preflight (`OPTIONS`) returns 204 with the
 * allow headers and never reaches a handler.
 *
 * Every response carries the same CORS headers, whether or not the request
 * had an `Origin`. The value never depends on the caller (it is always `*`, no
 * credentials), so there is nothing to withhold from an Origin-less request,
 * and omitting the headers there would be a bug: a cross-origin `<img>` /
 * `<video>` load is a no-cors request that sends no `Origin`, and its
 * long-lived cached response (attachments are `immutable` for a year, §5.8)
 * would then be reused for a later CORS `fetch()` of the same URL (e.g. to
 * verify `hash`), which fails without `Access-Control-Allow-Origin`.
 *
 * `Vary: Origin` is still sent, on every response. §3.4 requires it on a
 * response to a request with `Origin`, and sending it unconditionally keeps
 * every response identical whatever the `Origin` (so no cache can store an
 * Origin-less variant that differs from what a CORS request needs). The cost
 * is only that a cache may key entries per origin — a miss, never a wrong
 * answer.
 */
export function cors(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const isPreflight =
      c.req.method === "OPTIONS" &&
      c.req.header("origin") !== undefined &&
      c.req.header("access-control-request-method") !== undefined;
    if (isPreflight) {
      // Preflight (§3.4: `OPTIONS` with `Origin` and `Access-Control-Request-Method`):
      // answer with the allow set, no body. `*` is valid since we send no
      // credentials. Any other `OPTIONS` is an ordinary request and is routed.
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": ALLOW_METHODS,
          "access-control-allow-headers": OFSCP_HEADERS,
          "access-control-max-age": "600",
          vary: "Origin",
        },
      });
    }

    await next();
    c.res.headers.set("access-control-allow-origin", "*");
    c.res.headers.set("access-control-expose-headers", EXPOSE_HEADERS);
    addVaryOrigin(c.res.headers);
  };
}

/**
 * Add `Origin` to the response's `Vary` list, keeping whatever a handler
 * already listed there (overwriting it would let a cache serve the wrong
 * variant). `Vary: *` already covers every request header.
 */
export function addVaryOrigin(headers: Headers): void {
  const current = headers.get("vary");
  if (current === null || current.trim() === "") {
    headers.set("vary", "Origin");
    return;
  }
  const fields = current.split(",").map((f) => f.trim().toLowerCase());
  if (fields.includes("*") || fields.includes("origin")) return;
  headers.set("vary", `${current}, Origin`);
}
