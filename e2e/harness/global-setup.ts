/**
 * Playwright global setup: build the web client ONCE, before any worker starts.
 *
 * Previously every worker ran `vite build` itself (`ensureWebBuilt`), with no
 * lock. Vite empties `packages/web/dist` before writing, so whenever a worker
 * was replaced (Playwright tears a worker down after any test failure) the new
 * worker rebuilt `dist` in place while the other workers' servers were serving
 * from it — turning one red test into a cascade of unrelated timeouts.
 *
 * Building here, once, means workers only ever read a finished `dist`.
 * Environment variables set in global setup are inherited by workers, so the
 * flag below tells `ensureWebBuilt` not to rebuild.
 */
import { buildWebOnce } from "./fixtures.ts";

export default function globalSetup(): void {
  buildWebOnce();
  process.env.FORUMALL_E2E_WEB_BUILT = "1";
}
