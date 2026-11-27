/**
 * Static serving of the built web client with SPA fallback.
 *
 * Implemented directly on `Bun.file` (rather than hono/bun `serveStatic`) so the
 * served directory is an explicit, configurable **absolute** path — independent
 * of the process CWD — which matters for tests that point it at a temp dir.
 *
 * Behavior:
 *  - A request whose path maps to an existing file under `webDir` is served
 *    with the right content-type.
 *  - Any other path falls back to `index.html` (SPA client-side routing).
 *  - If `webDir` (or its `index.html`) does not exist, the handler returns
 *    `null` so the caller can fall through to the 404 handler — the app still
 *    boots cleanly with no web build present.
 *
 *  - The pages whose URL carries an invite token are sent with
 *    `Referrer-Policy: no-referrer`, so the token never leaks to another
 *    origin through a `Referer` header: the sign-up page at `/register`
 *    (§4.1.1: account-invite links `https://{authority}/register?invite={token}`)
 *    and the join-link page at `/invite/{token}` (§5.6 group invites).
 *
 * Path traversal (`..`, leading `/`) is normalized away before touching disk.
 */
import { join, normalize } from "node:path";

/**
 * Whether `pathname` is a page served at an invite link: the §4.1.1 sign-up
 * page (`/register`) or a §5.6 join-link page (`/invite/{token}`).
 */
function isInviteLinkPage(pathname: string): boolean {
  return pathname === "/register" || pathname === "/register/" || pathname.startsWith("/invite/");
}

/** Resolve a URL pathname to a safe absolute path inside `webDir`. */
function resolveSafe(webDir: string, pathname: string): string {
  // Strip query/hash already handled by URL; normalize collapses `..`.
  const decoded = decodeURIComponent(pathname);
  const rel = normalize(decoded)
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .replace(/^[/\\]+/, "");
  return join(webDir, rel);
}

/**
 * Build a request handler that serves static assets from `webDir` with SPA
 * fallback. Returns a `Response`, or `null` when nothing can be served (no web
 * build), letting the caller emit its own 404.
 */
export function createStaticHandler(webDir: string) {
  return async (pathname: string): Promise<Response | null> => {
    const indexFile = Bun.file(join(webDir, "index.html"));

    // Try the concrete asset first (only for non-root, file-looking paths).
    if (pathname !== "/" && pathname.length > 1) {
      const candidate = Bun.file(resolveSafe(webDir, pathname));
      if (await candidate.exists()) {
        return new Response(candidate);
      }
    }

    // SPA fallback: serve index.html for any remaining route.
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...(isInviteLinkPage(pathname) ? { "referrer-policy": "no-referrer" } : {}),
        },
      });
    }

    // No web build present — let the caller 404.
    return null;
  };
}
