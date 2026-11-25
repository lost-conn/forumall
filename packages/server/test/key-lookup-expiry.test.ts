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
