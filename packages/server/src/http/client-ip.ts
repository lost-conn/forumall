/**
 * Client IP resolution for rate-limit keying (§4.1.5, reconciliation #26).
 *
 * Ported from Antsome's `net.rs` reasoning: the only IP a caller cannot spoof
 * is the TCP peer address itself, so `X-Forwarded-For` is trusted ONLY when
 * `config.trustProxy` (`TRUST_PROXY` env, default `false`) says a reverse
 * proxy we control is the sole way to reach this process. Getting this wrong
 * in the "trust" direction with no such proxy in front is a spoofable rate
 * limiter — the default is chosen so a deployment that forgets to set it
 * fails closed (falls back to the peer address, or a shared "unknown" bucket)
 * rather than open.
 *
 * ## Rightmost hop, not "replace the header"
 * Forumall's own self-host topology (`Caddyfile`, `docker-compose.yml`) puts
 * exactly one trusted proxy directly in front of the app: Caddy's
 * `reverse_proxy` APPENDS the connecting peer's address to any existing
 * `X-Forwarded-For` rather than replacing it (unlike Antsome's bespoke
 * jkbase-proxy, which strips and replaces the header outright — see that
 * repo's `net.rs`). If jkbase also proxies in front of Caddy for a given
 * deployment, the same convention holds as long as it also appends (the
 * standard reverse-proxy behavior) rather than replaces: whatever the client
 * sent is untrusted and sits to the LEFT, and the entry OUR trusted proxy
 * appended — the RIGHTMOST one — is the one to use. This is the standard
 * "trust proxy" convention (same as Express's `trust proxy` / nginx
 * `set_real_ip_from`): trust exactly the last hop, because only that hop is
 * guaranteed to have been written by infrastructure we control.
 *
 * Enable `TRUST_PROXY=true` only when Forumall is NOT directly reachable on
 * its own port from the internet (the self-host Docker Compose satisfies
 * this: only Caddy publishes 80/443, the app only `expose`s its port inside
 * the compose network) — otherwise a direct caller can set
 * `X-Forwarded-For` to anything and spoof their way around the limiter.
 */
import { isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

import type { AppBindings } from "./types.ts";

const FORWARDED_HEADER = "x-forwarded-for";

/**
 * Best-effort TCP peer address. `undefined` outside a real `Bun.serve`
 * request — `getConnInfo` needs the Bun `Server` object Bun passes as the
 * second `fetch` argument, which `app.request(...)` (every unit/integration
 * test) never provides; it throws a `TypeError` in that case, treated here
 * the same as "unknown" (mirrors Antsome's `MaybePeerAddr`, which is `None`
 * for the equivalent `Router::oneshot` tests).
 */
function peerAddress(c: Context<AppBindings>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the caller's IP for rate-limit keying.
 *
 * - `trustProxy = true`: use the RIGHTMOST entry of `X-Forwarded-For` if
 *   present and a syntactically valid IP; otherwise fall back to the peer
 *   address.
 * - `trustProxy = false` (default): the header is ignored entirely — always
 *   the peer address, which cannot be spoofed by the caller.
 *
 * Returns `undefined` when neither source is available.
 */
export function clientIp(c: Context<AppBindings>, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const header = c.req.header(FORWARDED_HEADER);
    if (header) {
      const hops = header
        .split(",")
        .map((hop) => hop.trim())
        .filter((hop) => hop.length > 0);
      const rightmost = hops.at(-1);
      if (rightmost && isIP(rightmost) !== 0) return rightmost;
    }
  }
  return peerAddress(c);
}

/**
 * The rate-limit key for the caller's IP (`ip:<addr>`, or a shared
 * `ip:unknown` bucket when no address is resolvable at all — e.g. a test
 * harness with no real socket and an untrusted/missing proxy header). Matches
 * Antsome's `client_ip_key` fallback.
 */
export function clientIpKey(c: Context<AppBindings>, trustProxy: boolean): string {
  const ip = clientIp(c, trustProxy);
  return ip ? `ip:${ip}` : "ip:unknown";
}
