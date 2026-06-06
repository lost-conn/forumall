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
 * uses; a preflight `OPTIONS` short-circuits with a 204.
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
 * Permissive, credential-less CORS for the API + cross-provider well-known reads.
 * Applied app-wide before routing; a preflight (`OPTIONS`) returns 204 with the
 * allow headers and never reaches a handler.
 */
export function cors(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    // Only attach CORS headers when there IS an Origin (a same-origin or
    // server-to-server request has none and needs nothing here).
    if (origin === undefined) {
      await next();
      return;
    }

    if (c.req.method === "OPTIONS") {
      // Preflight: answer with the allow set, no body. `*` is valid since we send
      // no credentials.
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
    c.res.headers.set("access-control-expose-headers", OFSCP_HEADERS);
    c.res.headers.set("vary", "Origin");
  };
}
