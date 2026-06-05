/**
 * Server entry point.
 *
 * Boot sequence: load config → open the sqlite db → run migrations idempotently
 * → build the Hono app → serve via Bun. Designed for zero-config self-hosting:
 * with no env vars set it writes its state under `./data` and listens on
 * `localhost:3000`.
 */
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { migrate } from "./db/migrate.ts";

const config = loadConfig();

const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length > 0) {
  console.log(`[server] applied migrations: ${applied.join(", ")}`);
}

const app = createApp(config, { db });

console.log(`[server] forumall listening on http://localhost:${config.port}`);
console.log(`[server] domain=${config.domain} data=${config.dataDir}`);

export default {
  port: config.port,
  fetch: app.fetch,
};
