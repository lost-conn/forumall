/**
 * WS client tests (§7.1) against the REAL `@forumall/server` for fidelity.
 *
 * Each test boots the server on an ephemeral port via `Bun.serve` (the same
 * pattern as the server's own `ws.test.ts`), registers a device key over HTTP
 * with our signing `OfscpClient`, then drives `OfscpWsClient` through the signed
 * handshake (challenge → authenticate → authenticated), a subscribe, and a hub
 * fan-out event — asserting the client dispatches it to a per-type listener.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthBootstrapResponse,
  generateKeyPair,
  publicKeyFromPrivate,
} from "@forumall/shared";

import { type AppWithWebSocket, createApp } from "@forumall/server/src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "@forumall/server/src/config.ts";
import { openDb } from "@forumall/server/src/db/index.ts";
import { migrate } from "@forumall/server/src/db/migrate.ts";
import type { Hub } from "@forumall/server/src/provider/ws-hub.ts";

import { OfscpClient } from "../src/lib/ofscp-client.ts";
import { OfscpWsClient, OfscpWsRegistry } from "../src/lib/ofscp-ws.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";
const FAST_TIMINGS = {
  authTimeoutMs: 1000,
  challengeTtlMs: 10_000,
  pingIntervalMs: 200,
  idleTimeoutMs: 100_000,
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-web-ws-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Booted {
  hub: Hub;
  server: ReturnType<typeof Bun.serve>;
  host: string;
  wsUrl: string;
  httpBase: string;
}

const booted: Booted[] = [];
const registries: OfscpWsRegistry[] = [];

function boot(name: string): Booted {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app: AppWithWebSocket = createApp(config, { db, wsTimings: FAST_TIMINGS });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  const host = `${server.hostname}:${server.port}`;
  const b: Booted = {
    hub: app.__hub,
    server,
    host,
    wsUrl: `ws://${host}/api/ws`,
    httpBase: `http://${host}`,
  };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const r of registries.splice(0)) r.closeAll();
  for (const b of booted.splice(0)) b.server.stop(true);
});

interface Signer {
  actor: string;
  keyId: string;
  privateKey: string;
}

/** Register a user + device key over HTTP using the signing client's bootstrap plumbing. */
async function registerUser(b: Booted, handle: string): Promise<Signer> {
  const anon = new OfscpClient({ baseUrl: b.httpBase });
  const reg: AuthBootstrapResponse = await anon.register({ handle, password: "correct-horse" });
  const { privateKey } = generateKeyPair();
  const publicKey = publicKeyFromPrivate(privateKey);
  const dk = await anon.registerDeviceKey(reg.bootstrap_token, {
    publicKey,
    deviceName: "web-test",
  });
  return { actor: `${handle}@${DOMAIN}`, keyId: dk.key_id, privateKey };
}

/** Create a public group + channel via signed HTTP; return the channel id. */
async function makePublicChannel(b: Booted, signer: Signer): Promise<string> {
  const client = new OfscpClient({ baseUrl: b.httpBase, authority: DOMAIN, ...signer });
  const g = await client.post<{ id: string }>("/api/groups", { name: "g", tier: "public" });
  const c = await client.post<{ id: string }>(`/api/groups/${g.data.id}/channels`, {
    type: "text",
    name: "general",
    tier: "public",
  });
  return c.data.id;
}

function wsClientFor(b: Booted, signer: Signer): OfscpWsClient {
  // `host` is the LOGICAL provider domain used as the §7.1 signing authority
  // (the server verifies against its own `config.domain`); `url` is the actual
  // ephemeral transport endpoint.
  return new OfscpWsClient({
    host: DOMAIN,
    url: b.wsUrl,
    autoReconnect: false,
    ...signer,
  });
}

describe("OfscpWsClient handshake (§7.1)", () => {
  test("connect completes challenge → authenticate → authenticated", async () => {
    const b = boot("ws-handshake");
    const alice = await registerUser(b, "alice");
    const client = wsClientFor(b, alice);

    await client.connect();
    expect(client.state).toBe("connected");
    client.close();
  });

  test("connect rejects when the signature is invalid (wrong key)", async () => {
    const b = boot("ws-badsig");
    const alice = await registerUser(b, "alice");
    const wrong = generateKeyPair();
    const client = wsClientFor(b, { ...alice, privateKey: wrong.privateKey });
    await expect(client.connect()).rejects.toThrow();
    client.close();
  });
});

describe("OfscpWsClient subscriptions + dispatch (§7.1)", () => {
  test("subscribe then a hub channel event is dispatched to an on() listener", async () => {
    const b = boot("ws-subscribe");
    const alice = await registerUser(b, "alice");
    const channelId = await makePublicChannel(b, alice);

    const client = wsClientFor(b, alice);
    const subscribed = new Promise<string[]>((resolve) => {
      client.on("subscribed", (e) => resolve((e.data as { channels: string[] }).channels));
    });
    const created = new Promise<string>((resolve) => {
      client.on("message.created", (e) => resolve((e.data as { marker: string }).marker));
    });

    await client.connect();
    client.subscribe([channelId]);
    expect(await subscribed).toEqual([channelId]);

    // Server-side fan-out to the channel reaches the dispatched listener.
    b.hub.publishToChannel(channelId, {
      type: "message.created",
      data: { channelId, marker: "hello-web" },
    });
    expect(await created).toBe("hello-web");

    client.close();
  });

  test("client replies to a server ping with pong (heartbeat)", async () => {
    const b = boot("ws-heartbeat");
    const alice = await registerUser(b, "alice");
    const client = wsClientFor(b, alice);
    await client.connect();

    // The server pings authenticated connections every pingIntervalMs and closes
    // on idle; if our client never ponged, the connection would eventually drop.
    // Instead, assert it stays connected across several ping cycles.
    await Bun.sleep(FAST_TIMINGS.pingIntervalMs * 4);
    expect(client.state).toBe("connected");
    client.close();
  });

  test("subscribe before connect is replayed on (re)connect; cursor advances from events", async () => {
    const b = boot("ws-resubscribe");
    const alice = await registerUser(b, "alice");
    const channelId = await makePublicChannel(b, alice);

    const client = wsClientFor(b, alice);
    // Remember a subscription BEFORE connecting; it must be issued on connect.
    client.subscribe([channelId]);
    const subscribed = new Promise<string[]>((resolve) => {
      client.on("subscribed", (e) => resolve((e.data as { channels: string[] }).channels));
    });
    await client.connect();
    expect(await subscribed).toEqual([channelId]);

    // An event carrying a cursor advances the stored resume position.
    const got = new Promise<void>((resolve) => client.on("message.created", () => resolve()));
    b.hub.publishToChannel(channelId, {
      type: "message.created",
      data: { channelId, cursor: "cur_42", marker: "x" },
    });
    await got;
    expect(client.cursorFor(channelId)).toBe("cur_42");

    client.close();
  });
});

describe("OfscpWsRegistry (one client per host)", () => {
  test("returns the same client for a host and a fresh one per host", async () => {
    const b = boot("ws-registry");
    const alice = await registerUser(b, "alice");
    const registry = new OfscpWsRegistry();
    registries.push(registry);

    const cfg = { host: DOMAIN, url: b.wsUrl, autoReconnect: false, ...alice };
    const c1 = registry.get(cfg);
    const c2 = registry.get(cfg);
    expect(c1).toBe(c2);
    expect(registry.peek(DOMAIN)).toBe(c1);
    expect(registry.peek("other.example")).toBeUndefined();

    await c1.connect();
    expect(c1.state).toBe("connected");
  });
});
