/**
 * The per-identity key re-fetch limiter (§4.6 "MAY limit these re-fetches per
 * actor", §8.1 per provider, §8 Outbound requests): single flight, at most one
 * fetch per interval, and how long a suppressed caller must wait. Also the two
 * caches that use it, driven directly so concurrency is deterministic.
 */
import { describe, expect, test } from "bun:test";

import { RemoteDiscoveryCache } from "../src/provider/federation/discovery-cache.ts";
import type { FederationFetch } from "../src/provider/federation/http.ts";
import { RefetchLimiter } from "../src/provider/federation/refetch-limiter.ts";
import { RemoteUserKeysCache } from "../src/provider/federation/user-keys-cache.ts";

/** A manually released promise. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RefetchLimiter", () => {
  test("concurrent runs for one identity share a single fetch", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 1_000, now: c.now });
    const gate = deferred<string>();
    let fetches = 0;
    const fetch = () => {
      fetches += 1;
      return gate.promise;
    };
    const runs = [limiter.run("a", fetch), limiter.run("a", fetch), limiter.run("a", fetch)];
    gate.resolve("doc");
    expect(await Promise.all(runs)).toEqual(["doc", "doc", "doc"]);
    expect(fetches).toBe(1);
  });

  test("a second fetch inside the interval is rate_limited with the remaining wait", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 1_000, now: c.now });
    expect(await limiter.run("a", async () => "first")).toBe("first");
    c.advance(300);
    expect(await limiter.run("a", async () => "second")).toEqual({
      kind: "rate_limited",
      retryAfterMs: 700,
    });
  });

  test("after the interval a fetch runs again", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 1_000, now: c.now });
    await limiter.run("a", async () => "first");
    c.advance(1_000);
    expect(await limiter.run("a", async () => "second")).toBe("second");
  });

  test("identities are limited independently", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 1_000, now: c.now });
    await limiter.run("a", async () => "a");
    expect(await limiter.run("b", async () => "b")).toBe("b");
  });

  test("the interval counts from when a fetch STARTED, even a slow one", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 1_000, now: c.now });
    const gate = deferred<string>();
    const slow = limiter.run("a", () => gate.promise);
    c.advance(1_200); // the fetch takes longer than the interval
    gate.resolve("slow");
    await slow;
    expect(await limiter.run("a", async () => "next")).toBe("next");
  });

  test("interval 0 disables the limit but keeps single flight", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 0, now: c.now });
    await limiter.run("a", async () => "first");
    expect(await limiter.run("a", async () => "second")).toBe("second");
    const gate = deferred<string>();
    let fetches = 0;
    const fetch = () => {
      fetches += 1;
      return gate.promise;
    };
    const runs = [limiter.run("a", fetch), limiter.run("a", fetch)];
    gate.resolve("shared");
    expect(await Promise.all(runs)).toEqual(["shared", "shared"]);
    expect(fetches).toBe(1);
  });

  test("a clock that steps backwards never stretches the wait past the interval", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 1_000, now: c.now });
    await limiter.run("a", async () => "first");
    c.advance(-60_000);
    expect(await limiter.run("a", async () => "second")).toEqual({
      kind: "rate_limited",
      retryAfterMs: 1_000,
    });
  });

  test("a negative or non-finite interval is rejected", () => {
    expect(() => new RefetchLimiter({ intervalMs: -1, now: Date.now })).toThrow(RangeError);
    expect(() => new RefetchLimiter({ intervalMs: Number.NaN, now: Date.now })).toThrow(RangeError);
  });
});

describe("the caches route every fetch through the limiter", () => {
  /** A transport held until `release()`, counting calls. */
  function heldTransport(respond: () => Response) {
    const gate = deferred<void>();
    let calls = 0;
    const fetch: FederationFetch = async () => {
      calls += 1;
      await gate.promise;
      return respond();
    };
    return { fetch, release: () => gate.resolve(), calls: () => calls };
  }

  const keysDoc = () =>
    Response.json({
      actor: "alice@a.test",
      keys: [],
      cache_until: new Date(Date.now() + 3_600_000).toISOString(),
    });

  test("user keys: concurrent lookups share one fetch; the next one inside the interval is rate_limited", async () => {
    const c = clock(Date.now());
    const t = heldTransport(keysDoc);
    const cache = new RemoteUserKeysCache({ federationFetch: t.fetch, now: c.now });
    const lookups = [
      cache.lookupActorKey("alice@a.test", "k1"),
      cache.lookupActorKey("alice@a.test", "k2"),
      cache.lookupActorKey("alice@a.test", "k1", { forceRefresh: true }),
    ];
    t.release();
    for (const outcome of await Promise.all(lookups)) expect(outcome.kind).toBe("no_key");
    expect(t.calls()).toBe(1);

    c.advance(250);
    expect(await cache.lookupActorKey("alice@a.test", "k1")).toEqual({
      kind: "rate_limited",
      retryAfterMs: 750,
    });
    expect(t.calls()).toBe(1);
  });

  test("discovery: concurrent lookups share one fetch; the interval is configurable", async () => {
    const c = clock(Date.now());
    // An invalid document is a fetch failure — it is still a fetch, and limited.
    const t = heldTransport(() => Response.json({ nope: true }));
    const cache = new RemoteDiscoveryCache({
      federationFetch: t.fetch,
      now: c.now,
      refetchIntervalMs: 5_000,
    });
    const lookups = [
      cache.lookupProviderKey("a.test", "k1"),
      cache.lookupProviderKey("a.test", "k2"),
    ];
    t.release();
    for (const outcome of await Promise.all(lookups)) expect(outcome.kind).toBe("fetch_failed");
    expect(t.calls()).toBe(1);

    c.advance(1_000);
    expect(await cache.lookupProviderKey("a.test", "k1")).toEqual({
      kind: "rate_limited",
      retryAfterMs: 4_000,
    });
    c.advance(4_000);
    expect((await cache.lookupProviderKey("a.test", "k1")).kind).toBe("fetch_failed");
    expect(t.calls()).toBe(2);
  });
});
