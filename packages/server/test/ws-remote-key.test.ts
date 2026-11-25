/**
 * §7.1 "Close codes" for a REMOTE actor's direct-WS connection (§8.5), under
 * the §4.6 cache rules — `src/http/ws/remote-key-watch.ts`.
 *
 * One provider (`b.test`) with an injected user-keys cache whose transport is
 * a scripted fake for `a.test` (so each fetch outcome can be chosen) and whose
 * clock the test moves (so a cache entry's expiry is reached without waiting).
 * A remote actor `alice@a.test` authenticates over a real `Bun.serve`
 * WebSocket; the cases then drive the key re-check:
 *
 *  - key gone (valid response without it, `404`, a different key under the
 *    same id) → `4003`;
 *  - a failed, rate-limited or refused re-fetch keeps the connection until the
 *    cache entry expires, then `4001`; so does never trying;
 *  - a successful re-fetch before expiry keeps the connection past it;
 *  - with no cache entry (`cache_until` already past) the first failed
 *    re-fetch is `4001`;
 *  - the actor's provider becoming federation-denied is `4001` at once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type WsEnvelope,
  generateKeyPair,
  rfc3339Timestamp,
  signWsAuthenticate,
} from "@forumall/shared";

import { createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import type { WsTimings } from "../src/http/ws.ts";
import { EgressBlockedError } from "../src/provider/federation/egress-guard.ts";
import { RemoteUserKeysCache } from "../src/provider/federation/user-keys-cache.ts";
import type { Hub } from "../src/provider/ws-hub.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "b.test";
const REMOTE = "a.test";
const ACTOR = `alice@${REMOTE}`;
const KEY_ID = "dk_alice";
/** Heartbeat tick for these tests: every re-check runs on it. */
const TICK_MS = 20;
/** Long enough for several ticks: "the connection is still open". */
const QUIET_MS = 150;
/** The keys document's lifetime unless a case says otherwise. */
const TTL_MS = 60_000;
/**
 * Into the forced-refresh window of a fresh `TTL_MS` entry. The default lead
 * (120 s) exceeds half the entry's life, so the refresh point is halfway.
 */
const INTO_REFRESH_WINDOW_MS = TTL_MS / 2 + 1_000;

/** What the fake `a.test` answers to the next keys fetch. */
type Script =
  | "ok"
  | "without_key"
  | "not_found"
  | "other_key"
  | "server_error"
  | "network_error"
  | "refused";

interface Harness {
  readonly config: Config;
  readonly cache: RemoteUserKeysCache;
  /** Fetches the fake has answered (any outcome). */
  fetches: number;
  script: Script;
  /** `cache_until` offset from the cache clock for the next `ok` answer, ms. */
  ttlMs: number;
  /** Move the cache clock forward. */
  advance(ms: number): void;
  /** Hold every fetch until the returned release is called. */
  hold(): () => void;
  readonly hub: Hub;
  readonly url: string;
}

const keypair = generateKeyPair();
const otherKeypair = generateKeyPair();

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-ws-remote-key-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const stops: (() => void)[] = [];
const clients: WsClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const stop of stops.splice(0)) stop();
});

let bootCount = 0;
function boot(
  opts: { timings?: Partial<WsTimings>; refetchIntervalMs?: number; ttlMs?: number } = {},
): Harness {
  bootCount += 1;
  const name = `remote-key-${bootCount}`;
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  // Not frozen: one case changes the federation policy at runtime.
  const config: Config = { ...base, argon2: FAST_ARGON2, federationDeny: [] };
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  let gate: Promise<void> | null = null;

  const h: Harness = {
    config,
    cache: undefined as unknown as RemoteUserKeysCache,
    fetches: 0,
    script: "ok",
    ttlMs: opts.ttlMs ?? TTL_MS,
    advance(ms) {
      clockOffset += ms;
    },
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
    hub: undefined as unknown as Hub,
    url: "",
  };
  const keysDoc = (keys: { key_id: string; public_key: string }[]) =>
    Response.json({
      actor: ACTOR,
      keys: keys.map((k) => ({ ...k, algorithm: "Ed25519", created_at: "2026-01-01T00:00:00Z" })),
      cache_until: new Date(now() + h.ttlMs).toISOString(),
    });
  const cache = new RemoteUserKeysCache({
    now,
    refetchIntervalMs: opts.refetchIntervalMs ?? 0,
    federationFetch: async (domain) => {
      expect(domain).toBe(REMOTE);
      h.fetches += 1;
      if (gate) await gate;
      switch (h.script) {
        case "ok":
          return keysDoc([{ key_id: KEY_ID, public_key: keypair.publicKey }]);
        case "without_key":
          return keysDoc([]);
        case "other_key":
          return keysDoc([{ key_id: KEY_ID, public_key: otherKeypair.publicKey }]);
        case "not_found":
          return new Response("not found", { status: 404 });
        case "server_error":
          return new Response("oops", { status: 500 });
        case "network_error":
          throw new Error("connect ECONNREFUSED");
        case "refused":
          throw new EgressBlockedError(`${REMOTE} resolves to a non-public address`);
      }
    },
  });
  Object.assign(h, { cache });

  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, {
    testOnlySkipReplayWarmup: true,
    db,
    userKeysCache: cache,
    wsTimings: {
      authTimeoutMs: 1000,
      challengeTtlMs: 10_000,
      pingIntervalMs: TICK_MS,
      idleTimeoutMs: 100_000,
      ...opts.timings,
    },
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  stops.push(() => {
    server.stop(true);
    db.sqlite.close();
  });
  Object.assign(h, { hub: app.__hub, url: `ws://${server.hostname}:${server.port}/api/ws` });
  return h;
}

/** Minimal frame-queue WS client. */
class WsClient {
  readonly ws: WebSocket;
  private readonly queue: WsEnvelope[] = [];
  private readonly waiters: ((f: WsEnvelope) => void)[] = [];
  closeCode: number | undefined;
  closed = false;
  private readonly closeWaiters: (() => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (e) => {
      const frame = JSON.parse(String(e.data)) as WsEnvelope;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = true;
      this.closeCode = e.code;
      for (const w of this.closeWaiters.splice(0)) w();
    });
  }

  /** The next frame of `type` (skipping others, e.g. `ping`). */
  ofType(type: string, timeoutMs = 2000): Promise<WsEnvelope> {
    const i = this.queue.findIndex((f) => f.type === type);
    if (i !== -1) return Promise.resolve(this.queue.splice(i, 1)[0] as WsEnvelope);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      const waiter = (f: WsEnvelope) => {
        if (f.type !== type) {
          this.waiters.unshift(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push(waiter);
    });
  }

  waitClosed(timeoutMs = 2000): Promise<number | undefined> {
    if (this.closed) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve(this.closeCode);
      });
    });
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }
}

/** Connect to `h` as `alice@a.test` and complete the handshake. */
async function connectAlice(h: Harness): Promise<WsClient> {
  const client = await sendAliceAuthenticate(h);
  await client.ofType("authenticated");
  return client;
}

/** Connect to `h` and send alice's `authenticate`, without awaiting the answer. */
async function sendAliceAuthenticate(h: Harness): Promise<WsClient> {
  const client = new WsClient(h.url);
  clients.push(client);
  const challenge = await client.ofType("auth.challenge");
  const timestamp = rfc3339Timestamp();
  const { signature } = signWsAuthenticate({
    privateKey: keypair.privateKey,
    authority: DOMAIN,
    challengeNonce: (challenge.data as { nonce: string }).nonce,
    timestamp,
  });
  client.ws.send(
    JSON.stringify({
      id: "cli_auth",
      type: "authenticate",
      ts: rfc3339Timestamp(),
      data: { actor: ACTOR, keyId: KEY_ID, timestamp, signature },
    }),
  );
  return client;
}

/** Assert the connection stays open across several re-check ticks. */
async function expectStaysOpen(client: WsClient): Promise<void> {
  await Bun.sleep(QUIET_MS);
  expect(client.closed).toBe(false);
}

/** Assert the server sent an `unauthorized` error and closed with `code`. */
async function expectClosedWith(client: WsClient, code: number): Promise<void> {
  const err = await client.ofType("error");
  expect((err.data as { code: string }).code).toBe("unauthorized");
  expect(await client.waitClosed()).toBe(code);
}

describe("remote WS key re-check — key gone → 4003 (§7.1)", () => {
  const forcedEveryTick = { remoteKeyRevalidateMs: 0 };

  for (const [script, what] of [
    ["without_key", "a valid keys response without the key"],
    ["not_found", "a 404"],
    ["other_key", "a different public key under the same key id"],
  ] as const) {
    test(`${what} closes with 4003`, async () => {
      // No cache entry for the key (`cache_until` already past), so every
      // tick's lookup is a completed fetch.
      const h = boot({ timings: forcedEveryTick, ttlMs: -1000 });
      const alice = await connectAlice(h);
      await expectStaysOpen(alice);

      h.script = script;
      await expectClosedWith(alice, 4003);
    });
  }

  test("a re-fetch before expiry that shows the key gone closes with 4003", async () => {
    const h = boot();
    const alice = await connectAlice(h);
    h.script = "without_key";
    h.advance(INTO_REFRESH_WINDOW_MS); // every check now forces a re-fetch
    await expectClosedWith(alice, 4003);
  });
});

describe("remote WS key re-check — key unconfirmed → 4001 at expiry (§7.1)", () => {
  for (const script of ["server_error", "network_error", "refused"] as const) {
    test(`a ${script.replace("_", " ")} re-fetch keeps the connection until the entry expires`, async () => {
      const h = boot();
      const alice = await connectAlice(h);
      h.script = script;
      const before = h.fetches;
      h.advance(INTO_REFRESH_WINDOW_MS); // every check now forces a re-fetch
      await expectStaysOpen(alice);
      expect(h.fetches).toBeGreaterThan(before); // it did try

      h.advance(TTL_MS - INTO_REFRESH_WINDOW_MS);
      await expectClosedWith(alice, 4001);
    });
  }

  test("a rate-limited re-fetch keeps the connection until the entry expires", async () => {
    // One fetch per actor per hour: every forced re-fetch is suppressed.
    const h = boot({ refetchIntervalMs: 3_600_000 });
    const alice = await connectAlice(h);
    const fetchesAtAuth = h.fetches;
    h.advance(INTO_REFRESH_WINDOW_MS); // forced re-fetches are due, and suppressed
    await expectStaysOpen(alice);
    expect(h.fetches).toBe(fetchesAtAuth);

    h.advance(TTL_MS - INTO_REFRESH_WINDOW_MS);
    await expectClosedWith(alice, 4001);
  });

  test("with no re-fetch tried at all, the connection closes with 4001 at expiry", async () => {
    // No refresh lead and a re-check interval longer than the test.
    const h = boot({
      timings: { remoteKeyRevalidateMs: 3_600_000, remoteKeyRefreshLeadMs: 0 },
    });
    const alice = await connectAlice(h);
    const fetchesAtAuth = h.fetches;
    await expectStaysOpen(alice);

    h.advance(TTL_MS);
    await expectClosedWith(alice, 4001);
    expect(h.fetches).toBe(fetchesAtAuth);
  });

  test("the deadline timer closes at expiry without waiting for a heartbeat", async () => {
    // Heartbeat far longer than the test; the entry lives 300 ms of real time.
    const h = boot({
      ttlMs: 300,
      timings: {
        pingIntervalMs: 100_000,
        remoteKeyRevalidateMs: 3_600_000,
        remoteKeyRefreshLeadMs: 0,
      },
    });
    const alice = await connectAlice(h);
    expect(alice.closed).toBe(false);
    await expectClosedWith(alice, 4001);
  });

  test("an entry lapsing while a re-fetch is still in flight closes with 4001", async () => {
    const h = boot();
    const alice = await connectAlice(h);
    const release = h.hold(); // the next forced re-fetch never answers in time
    const before = h.fetches;
    h.advance(INTO_REFRESH_WINDOW_MS);
    await Bun.sleep(QUIET_MS);
    expect(h.fetches).toBe(before + 1); // started, still in flight
    expect(alice.closed).toBe(false);

    h.advance(TTL_MS - INTO_REFRESH_WINDOW_MS);
    await expectClosedWith(alice, 4001);
    release();
  });

  test("a handshake on a nearly expired cached entry re-fetches before it lapses", async () => {
    // No heartbeat during the test: only the watch's own timer can refresh.
    const h = boot({ timings: { pingIntervalMs: 100_000, remoteKeyRevalidateMs: 3_600_000 } });
    // Another request cached alice's keys 59.5 s ago; 500 ms of the entry remain.
    await h.cache.lookupActorKey(ACTOR, KEY_ID);
    h.advance(TTL_MS - 500);
    const alice = await connectAlice(h);
    const fetchesAtAuth = h.fetches;

    await Bun.sleep(600); // past the handshake entry's real-time expiry
    expect(h.fetches).toBeGreaterThan(fetchesAtAuth);
    expect(alice.closed).toBe(false);
    h.advance(1_000);
    await expectStaysOpen(alice);
  });

  test("a successful re-fetch before expiry keeps the connection past it", async () => {
    const h = boot();
    const alice = await connectAlice(h);
    const fetchesAtAuth = h.fetches;
    h.advance(INTO_REFRESH_WINDOW_MS);
    await Bun.sleep(QUIET_MS);
    expect(h.fetches).toBeGreaterThan(fetchesAtAuth); // refreshed ahead of expiry

    // Past the handshake's entry: the re-fetch has extended it, and so on.
    h.advance(INTO_REFRESH_WINDOW_MS);
    await expectStaysOpen(alice);
    h.advance(INTO_REFRESH_WINDOW_MS);
    await expectStaysOpen(alice);
  });
});

describe("remote WS key re-check — fetches made for another reason count (§7.1)", () => {
  // The watch makes no lookups of its own in these cases: no refresh lead and a
  // re-check interval longer than the test.
  const passive = { remoteKeyRevalidateMs: 3_600_000, remoteKeyRefreshLeadMs: 0 };

  test("another request's completed fetch without the key closes with 4003", async () => {
    const h = boot({ timings: passive });
    const alice = await connectAlice(h);
    const fetchesAtAuth = h.fetches;

    // A REST request signed with alice's other key makes the cache fetch her
    // keys; the response no longer publishes this connection's key.
    h.script = "without_key";
    expect((await h.cache.lookupActorKey(ACTOR, "dk_alice_2")).kind).toBe("no_key");
    await expectClosedWith(alice, 4003);
    expect(h.fetches).toBe(fetchesAtAuth + 1);
  });

  test("another request's 404 closes with 4003", async () => {
    const h = boot({ timings: passive });
    const alice = await connectAlice(h);
    h.script = "not_found";
    await h.cache.lookupActorKey(ACTOR, KEY_ID, { forceRefresh: true });
    await expectClosedWith(alice, 4003);
  });

  test("another request's refresh of the entry keeps the connection past the original expiry", async () => {
    const h = boot({ timings: passive });
    const alice = await connectAlice(h);
    h.advance(TTL_MS - 10_000);
    // Someone else's fetch refreshes the entry (another 60 s).
    expect((await h.cache.lookupActorKey(ACTOR, KEY_ID, { forceRefresh: true })).kind).toBe(
      "found",
    );
    h.advance(20_000); // past the handshake's entry, inside the refreshed one
    await expectStaysOpen(alice);
    h.advance(TTL_MS);
    await expectClosedWith(alice, 4001);
  });
});

describe("remote WS key re-check — no cache entry (§7.1)", () => {
  test("re-fetches keep the connection; the first failed one closes with 4001", async () => {
    const h = boot({ ttlMs: -1000, timings: { remoteKeyRevalidateMs: 0 } });
    const alice = await connectAlice(h);
    const fetchesAtAuth = h.fetches;
    await expectStaysOpen(alice);
    expect(h.fetches).toBeGreaterThan(fetchesAtAuth);

    h.script = "server_error";
    await expectClosedWith(alice, 4001);
  });

  test("a refused re-fetch closes with 4001 too", async () => {
    const h = boot({ ttlMs: -1000, timings: { remoteKeyRevalidateMs: 0 } });
    const alice = await connectAlice(h);
    h.script = "refused";
    await expectClosedWith(alice, 4001);
  });
});

describe("remote WS key re-check — federation policy (§7.1)", () => {
  test("the actor's provider becoming denied closes with 4001 at once", async () => {
    // A valid cached key and no re-fetch due: only the policy changes.
    const h = boot({
      timings: { remoteKeyRevalidateMs: 3_600_000, remoteKeyRefreshLeadMs: 0 },
    });
    const alice = await connectAlice(h);
    await expectStaysOpen(alice);
    const fetchesAtAuth = h.fetches;

    (h.config.federationDeny as string[]).push(REMOTE);
    await expectClosedWith(alice, 4001);
    expect(h.fetches).toBe(fetchesAtAuth);
  });
});

describe("remote WS handshake overtaken by a disconnect", () => {
  test("a client that disconnects while its key is being fetched is never registered", async () => {
    const h = boot();
    const release = h.hold();
    const alice = await sendAliceAuthenticate(h);
    await Bun.sleep(50); // the handshake is now waiting on the key fetch
    alice.close();
    await alice.waitClosed();

    release();
    await Bun.sleep(QUIET_MS);
    expect(h.hub.liveConnectionCount(ACTOR)).toBe(0);
  });
});
