/**
 * The per-host key-fetch bound (§8 Outbound requests: a stream of requests
 * naming random key ids must not make this provider hammer a third party):
 * token bucket + in-flight cap per canonical authority, bounded memory, and
 * how it composes with the per-identity {@link RefetchLimiter} in the
 * user-keys cache (random handles on one domain).
 */
import { describe, expect, test } from "bun:test";

import { HostFetchLimiter } from "../src/provider/federation/host-fetch-limiter.ts";
import type { FederationFetch } from "../src/provider/federation/http.ts";
import { type FetchAdmission, RefetchLimiter } from "../src/provider/federation/refetch-limiter.ts";
import { RemoteUserKeysCache } from "../src/provider/federation/user-keys-cache.ts";

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Admit `n` fetches to `host`, asserting each is admitted; return the releases. */
function admitN(limiter: HostFetchLimiter, host: string, n: number): Array<() => void> {
  return Array.from({ length: n }, () => {
    const a = limiter.tryStart(host);
    if (a.kind !== "admitted") throw new Error(`expected admission, got ${JSON.stringify(a)}`);
    return a.release;
  });
}

const limitsOf = (a: FetchAdmission) => (a.kind === "rate_limited" ? a.retryAfterMs : "admitted");

describe("HostFetchLimiter", () => {
  test("a burst is admitted, then the next start waits for one token", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({
      limits: { burst: 3, refillPerSecond: 2, maxInFlight: 10 },
      now: c.now,
    });
    for (const release of admitN(limiter, "victim.test", 3)) release();
    expect(limiter.tryStart("victim.test")).toEqual({ kind: "rate_limited", retryAfterMs: 500 });
    c.advance(200);
    expect(limitsOf(limiter.tryStart("victim.test"))).toBe(300);
  });

  test("the bucket refills after time passes, never beyond the burst", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({
      limits: { burst: 3, refillPerSecond: 2, maxInFlight: 10 },
      now: c.now,
    });
    for (const release of admitN(limiter, "victim.test", 3)) release();
    c.advance(500); // one token
    admitN(limiter, "victim.test", 1)[0]?.();
    expect(limiter.tryStart("victim.test").kind).toBe("rate_limited");
    c.advance(60_000); // long idle: refilled to the burst, not to 120
    for (const release of admitN(limiter, "victim.test", 3)) release();
    expect(limiter.tryStart("victim.test").kind).toBe("rate_limited");
  });

  test("different hosts do not throttle each other", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({ limits: { burst: 2, maxInFlight: 1 }, now: c.now });
    admitN(limiter, "victim.test", 1);
    expect(limiter.tryStart("victim.test").kind).toBe("rate_limited"); // in-flight cap
    // A port is part of the canonical authority (§2.2): a separate host.
    admitN(limiter, "other.test", 1);
    admitN(limiter, "victim.test:8443", 1);
  });

  test("the in-flight cap holds; the wait is until the oldest fetch's deadline", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({
      limits: { burst: 100, maxInFlight: 2, fetchDeadlineMs: 5_000 },
      now: c.now,
    });
    const [first, second] = admitN(limiter, "victim.test", 2);
    c.advance(1_500);
    expect(limiter.tryStart("victim.test")).toEqual({ kind: "rate_limited", retryAfterMs: 3_500 });
    first?.();
    first?.(); // a second release is ignored: it must not free another slot
    admitN(limiter, "victim.test", 1);
    expect(limiter.tryStart("victim.test").kind).toBe("rate_limited");
    second?.();
    admitN(limiter, "victim.test", 1);
  });

  test("a fetch running past its deadline still holds its slot; the wait is the 1 ms floor", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({
      limits: { maxInFlight: 1, fetchDeadlineMs: 5_000 },
      now: c.now,
    });
    admitN(limiter, "victim.test", 1);
    c.advance(9_000);
    expect(limiter.tryStart("victim.test")).toEqual({ kind: "rate_limited", retryAfterMs: 1 });
  });

  test("a refused start consumes nothing", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({
      limits: { burst: 2, refillPerSecond: 1, maxInFlight: 1 },
      now: c.now,
    });
    const [release] = admitN(limiter, "victim.test", 1);
    for (let i = 0; i < 10; i += 1)
      expect(limiter.tryStart("victim.test").kind).toBe("rate_limited");
    release?.();
    admitN(limiter, "victim.test", 1); // the second token was never spent by the refusals
  });

  test("idle hosts with a full bucket and nothing in flight are swept", () => {
    const c = clock();
    // Full refill = burst / rate = 2 s.
    const limiter = new HostFetchLimiter({ limits: { burst: 4, refillPerSecond: 2 }, now: c.now });
    for (let i = 0; i < 50; i += 1) admitN(limiter, `h${i}.test`, 1)[0]?.();
    const [busy] = admitN(limiter, "busy.test", 1); // stays in flight
    expect(limiter.trackedHosts).toBe(51);
    c.advance(1_999);
    admitN(limiter, "fresh.test", 1)[0]?.();
    expect(limiter.trackedHosts).toBe(52); // not yet a full refill
    c.advance(1);
    admitN(limiter, "fresh2.test", 1)[0]?.();
    // h0..h49 swept; busy.test (in flight), fresh.test (recent) and fresh2.test kept.
    expect(limiter.trackedHosts).toBe(3);
    busy?.();
    c.advance(2_000);
    limiter.tryStart("last.test");
    expect(limiter.trackedHosts).toBe(1);
  });

  test("at most maxHosts are tracked; the least recently used is evicted", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({ limits: { burst: 1, maxHosts: 3 }, now: c.now });
    for (const h of ["a.test", "b.test", "c.test"]) admitN(limiter, h, 1)[0]?.();
    expect(limiter.tryStart("a.test").kind).toBe("rate_limited"); // touch a: b is now LRU
    admitN(limiter, "d.test", 1); // evicts b
    expect(limiter.trackedHosts).toBe(3);
    expect(limiter.tryStart("a.test").kind).toBe("rate_limited"); // a's state was kept
    admitN(limiter, "b.test", 1); // b starts over with a full bucket
  });

  test("a full table never evicts a host with a fetch in flight", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({
      limits: { burst: 5, maxInFlight: 1, maxHosts: 2 },
      now: c.now,
    });
    const [releaseVictim] = admitN(limiter, "victim.test", 1); // busy, and the LRU
    admitN(limiter, "b.test", 1)[0]?.(); // idle
    admitN(limiter, "c.test", 1)[0]?.(); // table full: evicts idle b, not busy victim
    expect(limiter.trackedHosts).toBe(2);
    // victim's in-flight count survived, so its cap still holds.
    expect(limiter.tryStart("victim.test").kind).toBe("rate_limited");
    releaseVictim?.();
    expect(limiter.tryStart("victim.test").kind).toBe("admitted");
  });

  test("a new host is refused when every tracked host is busy", () => {
    const c = clock();
    const limiter = new HostFetchLimiter({ limits: { maxHosts: 2 }, now: c.now });
    const [releaseA] = admitN(limiter, "a.test", 1);
    admitN(limiter, "b.test", 1);
    const refused = limiter.tryStart("c.test");
    expect(refused.kind).toBe("rate_limited");
    if (refused.kind === "rate_limited") expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(limiter.trackedHosts).toBe(2);
    releaseA?.();
    expect(limiter.tryStart("c.test").kind).toBe("admitted"); // evicts the now-idle a
  });

  test("invalid limits are rejected", () => {
    const now = Date.now;
    for (const limits of [
      { burst: 0 },
      { burst: 1.5 },
      { maxInFlight: 0 },
      { maxHosts: 0 },
      { refillPerSecond: 0 },
      { refillPerSecond: Number.POSITIVE_INFINITY },
      { fetchDeadlineMs: -1 },
    ]) {
      expect(() => new HostFetchLimiter({ limits, now })).toThrow(RangeError);
    }
  });
});

describe("RefetchLimiter admission gate", () => {
  test("a gate refusal is returned as is and does not start the identity's interval", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 1_000, now: c.now });
    const refused: FetchAdmission = { kind: "rate_limited", retryAfterMs: 200 };
    expect(
      await limiter.run(
        "a",
        async () => "x",
        () => refused,
      ),
    ).toEqual(refused);
    // No fetch started, so the identity is not inside an interval.
    expect(await limiter.run("a", async () => "y")).toBe("y");
  });

  test("a lookup joining a fetch in flight does not ask the gate", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 1_000, now: c.now });
    let asked = 0;
    const gate = (): FetchAdmission => {
      asked += 1;
      return { kind: "admitted", release: () => {} };
    };
    let resolve!: (v: string) => void;
    const held = new Promise<string>((r) => {
      resolve = r;
    });
    const runs = [limiter.run("a", () => held, gate), limiter.run("a", () => held, gate)];
    resolve("doc");
    expect(await Promise.all(runs)).toEqual(["doc", "doc"]);
    expect(asked).toBe(1);
  });

  test("a fetch that rejects or throws synchronously releases its admission", async () => {
    const c = clock();
    const limiter = new RefetchLimiter<string>({ intervalMs: 0, now: c.now });
    const hosts = new HostFetchLimiter({ limits: { maxInFlight: 1 }, now: c.now });
    const admit = () => hosts.tryStart("victim.test");
    await expect(limiter.run("a", () => Promise.reject(new Error("down")), admit)).rejects.toThrow(
      "down",
    );
    await expect(
      limiter.run(
        "b",
        () => {
          throw new Error("sync");
        },
        admit,
      ),
    ).rejects.toThrow("sync");
    expect(await limiter.run("c", async () => "ok", admit)).toBe("ok");
  });
});

describe("user-keys cache: random handles on one domain", () => {
  /** A transport held until `release()`, counting calls per host. */
  function heldTransport(respond: () => Response | Promise<Response>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    const fetch: FederationFetch = async (domain) => {
      calls.push(domain);
      await gate;
      return respond();
    };
    return { fetch, release: () => release(), calls };
  }

  test("N distinct handles start far fewer than N fetches; the rest are rate_limited", async () => {
    const c = clock(Date.now());
    const t = heldTransport(() => new Response(null, { status: 404 }));
    const cache = new RemoteUserKeysCache({
      federationFetch: t.fetch,
      now: c.now,
      hostFetchLimits: { burst: 5, refillPerSecond: 1, maxInFlight: 10 },
    });
    // Every lookup is admitted or refused synchronously, while all fetches are held.
    const lookups = Array.from({ length: 50 }, (_, i) =>
      cache.lookupActorKey(`r${i}@victim.test`, "k1"),
    );
    t.release();
    const outcomes = await Promise.all(lookups);
    expect(t.calls).toHaveLength(5);
    expect(outcomes.filter((o) => o.kind === "no_key")).toHaveLength(5);
    const limited = outcomes.filter((o) => o.kind === "rate_limited");
    expect(limited).toHaveLength(45);
    for (const o of limited) expect(o).toEqual({ kind: "rate_limited", retryAfterMs: 1_000 });

    // Another host is untouched by victim.test's exhaustion.
    expect((await cache.lookupActorKey("alice@other.test", "k1")).kind).toBe("no_key");
    // After the refill, one more victim.test fetch is admitted.
    c.advance(1_000);
    expect((await cache.lookupActorKey("r99@victim.test", "k1")).kind).toBe("no_key");
    expect(t.calls.filter((h) => h === "victim.test")).toHaveLength(6);
  });

  test("the in-flight cap holds under concurrency, and failed fetches free their slots", async () => {
    const c = clock(Date.now());
    const t = heldTransport(() => {
      throw new Error("connection reset");
    });
    const cache = new RemoteUserKeysCache({
      federationFetch: t.fetch,
      now: c.now,
      hostFetchLimits: { burst: 100, maxInFlight: 3, fetchDeadlineMs: 5_000 },
    });
    const first = Array.from({ length: 10 }, (_, i) =>
      cache.lookupActorKey(`r${i}@victim.test`, "k1"),
    );
    t.release();
    const outcomes = await Promise.all(first);
    expect(t.calls).toHaveLength(3);
    expect(outcomes.filter((o) => o.kind === "fetch_failed")).toHaveLength(3);
    expect(outcomes.filter((o) => o.kind === "rate_limited")).toHaveLength(7);
    for (const o of outcomes.filter((o) => o.kind === "rate_limited")) {
      expect(o).toEqual({ kind: "rate_limited", retryAfterMs: 5_000 });
    }
    // The three failures released their slots: three new handles start at once.
    const again = await Promise.all(
      Array.from({ length: 3 }, (_, i) => cache.lookupActorKey(`s${i}@victim.test`, "k1")),
    );
    for (const o of again) expect(o.kind).toBe("fetch_failed");
    expect(t.calls).toHaveLength(6);
  });
});
