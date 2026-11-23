/**
 * Problem-type description pages (OFSCP §2.6).
 *
 * Every problem response this provider emits has `type`
 * `https://{authority}/problems/{errorCode}` (see `http/errors.ts`), and §2.6
 * says providers SHOULD serve a human-readable description at that URL. This
 * router serves `GET /problems/{errorCode}` as a tiny static HTML page for each
 * §7.3 registry code (Forumall uses no extension codes), and a problem+json 404
 * for anything else. Clients MUST NOT depend on `type` (they key on
 * `errorCode`), so this page is documentation for humans only.
 *
 * Mounted at the root before the SPA static handler so the index.html fallback
 * never shadows it.
 */
import { Hono } from "hono";

import { AppError, ERROR_CODE_REGISTRY, isRegistryErrorCode } from "./errors.ts";
import type { AppBindings } from "./types.ts";

/** Descriptions never change at runtime; let clients/proxies cache them. */
const CACHE_CONTROL = "public, max-age=86400";

function page(code: string, status: number, meaning: string): string {
  // Every interpolated value comes from the static registry (a `code` is only
  // rendered after `isRegistryErrorCode` matched it), so nothing here is
  // caller-controlled and no escaping is needed.
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${code} (${status})</title></head>
<body>
<h1>${code}</h1>
<p>HTTP status <strong>${status}</strong>.</p>
<p>${meaning}</p>
<p>This is an OFSCP problem type (OFSCP §2.6, §7.3). Clients identify the problem by its <code>errorCode</code>, not by this URL.</p>
</body>
</html>
`;
}

export function createProblemsRouter() {
  const router = new Hono<AppBindings>();

  router.get("/problems/:code", (c) => {
    const code = c.req.param("code");
    if (!isRegistryErrorCode(code)) {
      throw AppError.notFound({ detail: "no such problem type" });
    }
    const { status, meaning } = ERROR_CODE_REGISTRY[code];
    c.header("Cache-Control", CACHE_CONTROL);
    return c.html(page(code, status, meaning));
  });

  return router;
}
