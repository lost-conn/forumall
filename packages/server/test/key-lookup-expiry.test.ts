/**
 * A `found` key lookup reports when the cache entry vouching for it lapses
 * (`expiresAt`, on the cache's clock), or `null` when the key came from a fetch
 * whose document was not cached — what §7.1 remote-WS re-resolution keys its
 * `4001` deadline on (`src/http/ws/remote-key-watch.ts`).
 */
import { describe, expect, test } from "bun:test";

import type { FederationFetch } from "../src/provider/federation/http.ts";
import { RemoteUserKeysCache } from "../src/provider/federation/user-keys-cache.ts";

const ACTOR = "alice@a.test";
const KEY = {
  key_id: "k1",
  algorithm: "Ed25519",
  public_key: "pk",
  created_at: "2026-01-01T00:00:00Z",
};

function cacheAnswering(cacheUntil: () => string, opts: { maxTtlMs?: number } = {}) {
  let now = Date.parse("2026-06-01T00:00:00Z");
  let calls = 0;
  const federationFetch: FederationFetch = async () => {
    calls += 1;
    return Response.json({ actor: ACTOR, keys: [KEY], cache_until: cacheUntil() });
  };
  const cache = new RemoteUserKeysCache({
    federationFetch,
    now: () => now,
    refetchIntervalMs: 0,
    ...opts,
  });
  return {
    cache,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    calls: () => calls,
  };
}

describe("KeyLookup found.expiresAt", () => {
  test("a fetched-and-cached key carries the entry's expiry; a cache hit carries the same", async () => {
    const h = cacheAnswering(() => new Date(h.now() + 60_000).toISOString());
    const start = h.now();
    expect(await h.cache.lookupActorKey(ACTOR, "k1")).toMatchObject({
      kind: "found",
      fresh: true,
      expiresAt: start + 60_000,
    });
    h.advance(10_000);
    expect(await h.cache.lookupActorKey(ACTOR, "k1")).toMatchObject({
      kind: "found",
      fresh: false,
      expiresAt: start + 60_000,
    });
    expect(h.calls()).toBe(1);
    expect(h.cache.now()).toBe(start + 10_000);
  });

  test("the expiry is capped by maxTtlMs, like the entry itself", async () => {
    const h = cacheAnswering(() => new Date(h.now() + 7_200_000).toISOString(), {
      maxTtlMs: 600_000,
    });
    expect(await h.cache.lookupActorKey(ACTOR, "k1")).toMatchObject({
      kind: "found",
      expiresAt: h.now() + 600_000,
    });
  });

  test("a key from a document that was not cached (cache_until past) has expiresAt null", async () => {
    const h = cacheAnswering(() => new Date(h.now() - 1_000).toISOString());
    expect(await h.cache.lookupActorKey(ACTOR, "k1")).toMatchObject({
      kind: "found",
      fresh: true,
      expiresAt: null,
    });
    // Nothing was cached, so the next lookup fetches again.
    await h.cache.lookupActorKey(ACTOR, "k1");
    expect(h.calls()).toBe(2);
  });
});

describe("RemoteUserKeysCache.lastCompletedFetch", () => {
  test("reports the last completed fetch, cached or not, and forgets it on invalidate", async () => {
    let status = 200;
    let ttlMs = 60_000;
    let now = Date.parse("2026-06-01T00:00:00Z");
    const federationFetch: FederationFetch = async () =>
      status === 404
        ? new Response("no", { status: 404 })
        : Response.json({
            actor: ACTOR,
            keys: [KEY],
            cache_until: new Date(now + ttlMs).toISOString(),
          });
    const cache = new RemoteUserKeysCache({
      federationFetch,
      now: () => now,
      refetchIntervalMs: 0,
    });

    expect(cache.lastCompletedFetch(ACTOR, "k1")).toBeNull();

    await cache.lookupActorKey(ACTOR, "k1");
    expect(cache.lastCompletedFetch(ACTOR, "k1")).toMatchObject({
      key: { keyId: "k1", publicKey: "pk" },
      expiresAt: now + 60_000,
    });
    expect(cache.lastCompletedFetch(ACTOR, "other")).toMatchObject({ key: null });

    // Expired entry: the fetch is still the last evidence, but vouches for nothing.
    now += 61_000;
    expect(cache.lastCompletedFetch(ACTOR, "k1")).toMatchObject({ expiresAt: null });

    // An uncacheable document is still recorded.
    ttlMs = -1_000;
    await cache.lookupActorKey(ACTOR, "k1");
    expect(cache.lastCompletedFetch(ACTOR, "k1")).toMatchObject({
      key: { keyId: "k1" },
      expiresAt: null,
    });

    status = 404;
    await cache.lookupActorKey(ACTOR, "k1");
    expect(cache.lastCompletedFetch(ACTOR, "k1")).toEqual({ key: null, expiresAt: null });

    cache.invalidate(ACTOR);
    expect(cache.lastCompletedFetch(ACTOR, "k1")).toBeNull();
  });
});

describe("RemoteUserKeysCache remembered fetches are bounded", () => {
  test("beyond maxRememberedFetches the least recently fetched actor is forgotten", async () => {
    // Every actor is unknown (404): a completed fetch, recorded as "no key".
    const federationFetch: FederationFetch = async () => new Response(null, { status: 404 });
    const cache = new RemoteUserKeysCache({
      federationFetch,
      refetchIntervalMs: 0,
      maxRememberedFetches: 2,
    });
    for (const handle of ["r1", "r2", "r1", "r3"]) {
      await cache.lookupActorKey(`${handle}@a.test`, "k1");
    }
    // r1 was fetched again after r2, so r2 is the oldest and goes first.
    expect(cache.lastCompletedFetch("r2@a.test", "k1")).toBeNull();
    expect(cache.lastCompletedFetch("r1@a.test", "k1")).not.toBeNull();
    expect(cache.lastCompletedFetch("r3@a.test", "k1")).not.toBeNull();
  });
});
