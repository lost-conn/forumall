/**
 * Server entry point.
 *
 * Boot sequence: load + validate config → open the sqlite db → run migrations
 * idempotently → ensure the media dir exists → generate the provider signing key
 * (first boot only) → build the Hono app → serve via Bun. Designed for
 * zero-config self-hosting: with no env vars set it writes its state under
 * `./data` and listens on `localhost:3000`. The only thing a real (federating)
 * deployment must set is `DOMAIN`.
 */
import dns from "node:dns";
import { mkdirSync } from "node:fs";
import { ZodError } from "zod";
import { createApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { migrate } from "./db/migrate.ts";
import { getProviderSigningKey } from "./provider/signing-key.ts";

/**
 * Load config, turning a Zod validation failure into a single, human-readable,
 * actionable error instead of a stack trace. Each bad env var is reported as
 * `NAME: <message>` so an operator can see exactly which value to fix.
 */
function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ZodError) {
      console.error("[server] configuration error — fix these env vars and restart:");
      for (const issue of err.issues) {
        const name = issue.path.join(".") || "(env)";
        console.error(`  • ${name}: ${issue.message}`);
      }
      console.error("[server] see .env.example for every supported variable + its default.");
      process.exit(1);
    }
    throw err;
  }
}

const config = loadConfigOrExit();

// Apply the outbound DNS address-family preference before any `fetch` runs.
// Default `ipv4first`: self-host targets that NAT only IPv4 (Firecracker microVMs,
// some PaaS sandboxes) have no IPv6 egress, so a dual-stack fetch that picks an
// AAAA address black-holes — this is what kills Web Push delivery to FCM/Mozilla
// and federation calls on such a host. `setDefaultResultOrder` is wrapped because
// it's absent on older/edge runtimes (then we simply keep the platform default).
try {
  dns.setDefaultResultOrder(config.dnsResultOrder);
} catch {
  /* runtime without the API — non-fatal, keep the default order */
}

// Optionally override the resolver(s). Needed on hosts that come up with no
// working DNS configured (e.g. a microVM booted via kernel `ip=` autoconfig with
// no nameserver field): outbound hostnames otherwise resolve to nothing and Web
// Push / federation fail before any connection. Default unset → system resolver.
if (config.dnsServers.length > 0) {
  try {
    dns.setServers(config.dnsServers as string[]);
    console.log(`[server] DNS resolver(s) overridden: ${config.dnsServers.join(", ")}`);
  } catch (err) {
    console.error(`[server] failed to apply DNS_SERVERS (${config.dnsServers.join(", ")}):`, err);
  }
}

const db = openDb(config.dbPath);
const applied = migrate(db);
if (applied.length > 0) {
  console.log(`[server] applied migrations: ${applied.join(", ")}`);
}

// Create the media directory up front so a fresh install's first upload (and any
// backup script) finds it already present. FsStorage also creates it lazily, but
// materializing it on boot makes the data layout visible immediately. `:memory:`
// test DBs still get a real media dir, which is harmless.
mkdirSync(config.mediaDir, { recursive: true });

// Ensure the provider's Ed25519 signing identity exists (§8.1). Generated once
// on first boot and reused thereafter.
const providerKey = getProviderSigningKey(db);

// Friendly startup summary. A self-hoster should be able to read these few lines
// and know exactly what got configured and where their data lives.
const scheme = config.domain.startsWith("localhost") ? "http" : "https";
console.log("[server] forumall is starting up");
console.log(`[server]   provider domain : ${config.domain}`);
console.log(`[server]   listening on    : http://localhost:${config.port}`);
console.log(`[server]   data dir        : ${config.dataDir}`);
console.log(`[server]   database        : ${config.dbPath}`);
console.log(`[server]   media dir       : ${config.mediaDir}`);
console.log(`[server]   provider key id : ${providerKey.keyId}`);

if (config.domainIsDefault) {
  console.warn(
    "[server]   ⚠ DOMAIN is not set — falling back to a localhost authority. This is fine\n" +
      "[server]     for local testing, but a real / federated deployment MUST set DOMAIN to\n" +
      "[server]     the public hostname this provider is reached at (it is the OFSCP signing\n" +
      "[server]     authority / `iss`). Set DOMAIN in .env and restart before going public.",
  );
}

console.log(`[server] ready at ${scheme}://${config.domain}`);

const app = createApp(config, { db });

// Bun's WebSocket support requires the entry to export a `websocket` handler
// object alongside `fetch` (§7.1). `createApp` builds it and attaches it as
// `app.__websocket`; the upgrade route lives on the app, and Bun routes accepted
// upgrades into this handler.
export default {
  port: config.port,
  fetch: app.fetch,
  websocket: app.__websocket,
};
