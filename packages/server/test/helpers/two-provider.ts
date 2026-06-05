/**
 * Two-provider federation test harness (spec §8).
 *
 * Boots two `createApp` instances on ephemeral ports via `Bun.serve` and wires
 * an injected `federationFetch` that maps each logical OFSCP domain (e.g.
 * `a.test`, `b.test`) to the right `http://localhost:{port}` — while preserving
 * the request's authority/Host as the real domain, so a peer's signature
 * verification (which binds its own `config.domain` as the authority) still
 * matches. This lets `signedProviderFetch` and the discovery cache reach an
 * in-process peer exactly as they would a real remote provider over TLS.
 *
 * Later P7 cards (remote actor key resolution, remote channel join) reuse this
 * shape: register more domains in the map, or grab `a.discoveryCache` /
 * `b.federationFetch` for their own assertions.
 *
 * Servers + sockets are stopped in {@link Federation.stop} so suites exit clean.
 */
import { type AppWithWebSocket, createApp } from "../../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../../src/config.ts";
import { openDb } from "../../src/db/index.ts";
import { migrate } from "../../src/db/migrate.ts";
import type { RemoteDiscoveryCache } from "../../src/provider/federation/discovery-cache.ts";
import type { FederationFetch } from "../../src/provider/federation/http.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };

/** One booted provider in the harness. */
export interface Provider {
  readonly domain: string;
  readonly app: AppWithWebSocket;
  readonly config: Config;
  readonly db: ReturnType<typeof openDb>;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly discoveryCache: RemoteDiscoveryCache;
  /** The injected federation fetch (pass to `signedProviderFetch` to reach the peer). */
  readonly federationFetch: FederationFetch;
  /** `http://localhost:{port}` base for direct (non-federation) requests. */
  readonly base: string;
}

export interface Federation {
  readonly a: Provider;
  readonly b: Provider;
  /** Stop both servers + close both sqlite handles. */
  stop(): void;
}

/**
 * Build a `federationFetch` that maps logical domains → localhost base URLs,
 * preserving the authority. `ports` maps each domain to its localhost port; an
 * unknown domain rejects (so a request to an un-resolvable provider surfaces as
 * a fetch failure, not a silent localhost hit).
 */
export function mappedFederationFetch(ports: Map<string, number>): FederationFetch {
  return async (domain, request) => {
    const port = ports.get(domain);
    if (port === undefined) {
      throw new Error(`no in-process peer mapped for domain ${domain}`);
    }
    const original = new URL(request.url);
    const localUrl = `http://localhost:${port}${original.pathname}${original.search}`;
    // Rebuild the request against the local URL, preserving method/body and all
    // headers (including the X-OFSCP-* signing headers and the original Host so
    // the peer's authority binding still matches its config.domain).
    const headers = new Headers(request.headers);
    headers.set("host", original.host);
    const init: RequestInit = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }
    return fetch(localUrl, init);
  };
}

/**
 * Boot a two-provider federation. Each provider's injected `federationFetch`
 * resolves both domains, so either can call the other. The DBs live under
 * `dir` (one sqlite file per provider).
 */
export function startFederation(dir: string, domainA = "a.test", domainB = "b.test"): Federation {
  const ports = new Map<string, number>();
  const federationFetch = mappedFederationFetch(ports);

  const boot = (domain: string, name: string): Provider => {
    const base = loadConfig({
      DATA_DIR: dir,
      DB_PATH: `${dir}/${name}.sqlite`,
      WEB_DIR: `${dir}/${name}-web`,
      DOMAIN: domain,
    });
    const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
    const db = openDb(config.dbPath);
    migrate(db);
    const app = createApp(config, { db, federationFetch });
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
    ports.set(domain, server.port);
    return {
      domain,
      app,
      config,
      db,
      server,
      discoveryCache: app.__discoveryCache,
      federationFetch,
      base: `http://localhost:${server.port}`,
    };
  };

  const a = boot(domainA, "fed-a");
  const b = boot(domainB, "fed-b");

  return {
    a,
    b,
    stop() {
      a.server.stop(true);
      b.server.stop(true);
      a.db.sqlite.close();
      b.db.sqlite.close();
    },
  };
}
