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
import { getProviderSigningKey } from "./provider/signing-key.ts";

const config = loadConfig();

const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length > 0) {
  console.log(`[server] applied migrations: ${applied.join(", ")}`);
}

// Ensure the provider's Ed25519 signing identity exists (§8.1). Generated once
// on first boot and reused thereafter.
const providerKey = getProviderSigningKey(db);
console.log(`[server] provider signing key id=${providerKey.keyId}`);

const app = createApp(config, { db });

console.log(`[server] forumall listening on http://localhost:${config.port}`);
console.log(`[server] domain=${config.domain} data=${config.dataDir}`);

// Bun's WebSocket support requires the entry to export a `websocket` handler
// object alongside `fetch` (§7.1). `createApp` builds it and attaches it as
// `app.__websocket`; the upgrade route lives on the app, and Bun routes accepted
// upgrades into this handler.
export default {
  port: config.port,
  fetch: app.fetch,
  websocket: app.__websocket,
};
