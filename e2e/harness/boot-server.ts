/**
 * Ephemeral @forumall/server boot script (P8 e2e harness).
 *
 * Spawned by the Playwright fixture under `bun`. It:
 *   - picks a free TCP port,
 *   - loads config with DATA_DIR pointed at a temp dir and DOMAIN pinned to
 *     `localhost:<port>` (so the §4.4.2 signing authority — which the browser
 *     derives from `location.host` — matches what the server verifies against),
 *   - serves the prebuilt web client from WEB_DIR (packages/web/dist),
 *   - runs migrations, brings up the Hono app + Bun WS handler, and
 *   - prints a single `__READY__ {"port":N,"baseUrl":"..."}` line on stdout so
 *     the parent can capture the URL, then serves until killed.
 *
 * Env in:
 *   DATA_DIR   temp data dir (required)
 *   WEB_DIR    built web dist dir (required)
 *   PORT       optional fixed port; otherwise a free one is chosen
 */
import { createServer } from "node:net";
import { createApp } from "../../packages/server/src/app.ts";
import { loadConfig } from "../../packages/server/src/config.ts";
import { openDb } from "../../packages/server/src/db/index.ts";
import { migrate } from "../../packages/server/src/db/migrate.ts";
import { getProviderSigningKey } from "../../packages/server/src/provider/signing-key.ts";

/** Find a free TCP port by binding to 0 and reading the assigned port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const dataDir = process.env.DATA_DIR;
const webDir = process.env.WEB_DIR;
if (!dataDir || !webDir) {
  console.error("boot-server: DATA_DIR and WEB_DIR are required");
  process.exit(1);
}

const port = process.env.PORT ? Number(process.env.PORT) : await freePort();
const domain = `localhost:${port}`;

const config = loadConfig({
  PORT: String(port),
  DOMAIN: domain,
  DATA_DIR: dataDir,
  WEB_DIR: webDir,
  // Forward the optional feature toggles a spec may set via the harness env so
  // they reach `loadConfig` (which otherwise sees only these explicit keys, not
  // the ambient process env). Used by the discover-feed e2e (default OFF → 404).
  ...(process.env.ENABLE_DISCOVER_FEED !== undefined
    ? { ENABLE_DISCOVER_FEED: process.env.ENABLE_DISCOVER_FEED }
    : {}),
  ...(process.env.ENABLE_KNOWN_PROVIDERS !== undefined
    ? { ENABLE_KNOWN_PROVIDERS: process.env.ENABLE_KNOWN_PROVIDERS }
    : {}),
});

const db = openDb(config.dbPath);
migrate(db);
getProviderSigningKey(db); // ensure §8.1 provider identity exists

// Optional short WS heartbeat/idle timings (§7.1) so the presence e2e can observe
// disconnect→offline quickly when a connection drops without a clean close. A
// clean page/context close already fans out `offline` immediately via the WS
// `close` handler; these shorten the idle-sweep fallback for ungraceful drops.
const num = (v: string | undefined): number | undefined =>
  v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined;
const wsTimings = {
  ...(num(process.env.WS_PING_INTERVAL_MS) !== undefined
    ? { pingIntervalMs: num(process.env.WS_PING_INTERVAL_MS) as number }
    : {}),
  ...(num(process.env.WS_IDLE_TIMEOUT_MS) !== undefined
    ? { idleTimeoutMs: num(process.env.WS_IDLE_TIMEOUT_MS) as number }
    : {}),
};

const app = createApp(config, {
  db,
  ...(Object.keys(wsTimings).length > 0 ? { wsTimings } : {}),
});

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
  websocket: app.__websocket,
});

const baseUrl = `http://localhost:${server.port}`;
// Single machine-readable ready line for the parent fixture.
console.log(`__READY__ ${JSON.stringify({ port: server.port, baseUrl })}`);

// Stay alive until the parent kills us.
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});

// Parent-death watchdog: if the Playwright worker that spawned us dies without
// running the fixture teardown (e.g. it was SIGKILLed, or the whole run was
// aborted), we'd otherwise leak — a still-bound ephemeral port + a still-mounted
// temp DATA_DIR. The fixture passes its own pid as PARENT_PID; once that process
// is gone, no one will ever call stop(), so we self-terminate. `kill(pid, 0)`
// only probes liveness (throws ESRCH when the process no longer exists).
const parentPid = process.env.PARENT_PID ? Number(process.env.PARENT_PID) : undefined;
if (parentPid !== undefined && Number.isFinite(parentPid)) {
  const watchdog = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      // Parent gone → release the port and exit (the parent's stop() removes the
      // temp dir on the normal path; here we just stop holding resources).
      clearInterval(watchdog);
      server.stop(true);
      process.exit(0);
    }
  }, 1000);
  // Don't let the watchdog timer itself keep the event loop alive.
  watchdog.unref?.();
}
