/**
 * Memory bounds on the remote-key caches: both are keyed by identities a
 * requester chooses (actors, provider authorities), so the cached documents,
 * each document's body, and the user-keys cache's record of last fetches must
 * all be bounded (`expiring-entries.ts`, `key-lookup.ts`, `user-keys-cache.ts`,
 * `discovery-cache.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { RemoteDiscoveryCache } from "../src/provider/federation/discovery-cache.ts";
import {
  EXPIRED_SWEEP_INTERVAL_MS,
  ExpiringEntries,
} from "../src/provider/federation/expiring-entries.ts";
import type { FederationFetch } from "../src/provider/federation/http.ts";
import { RemoteUserKeysCache } from "../src/provider/federation/user-keys-cache.ts";

const START = Date.parse("2026-06-01T00:00:00Z");

function clock() {
  let now = START;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ExpiringEntries", () => {
  test("get answers only unexpired entries and removes an expired one", () => {
    const c = clock();
    const entries = new ExpiringEntries<string>({ maxEntries: 10, now: c.now });
    entries.set("a", "doc-a", START + 1_000);
    expect(entries.get("a")).toEqual({ doc: "doc-a", expiresAt: START + 1_000 });
    c.advance(1_000);
    expect(entries.get("a")).toBeNull();
    expect(entries.size).toBe(0);
  });

  test("past maxEntries the least recently used entry is evicted; a read counts as use", () => {
    const c = clock();
    const entries = new ExpiringEntries<string>({ maxEntries: 2, now: c.now });
    entries.set("a", "a", START + 60_000);
    entries.set("b", "b", START + 60_000);
    expect(entries.get("a")).not.toBeNull(); // b is now the least recently used
    entries.set("c", "c", START + 60_000);
    expect(entries.size).toBe(2);
    expect(entries.get("b")).toBeNull();
    expect(entries.get("a")).not.toBeNull();
    expect(entries.get("c")).not.toBeNull();
  });

  test("a store after the sweep interval removes every expired entry, not only the oldest", () => {
    const c = clock();
    const entries = new ExpiringEntries<string>({ maxEntries: 100, now: c.now });
    // Expiries out of insertion order: the long-lived entry comes first.
    entries.set("long", "long", START + 10 * EXPIRED_SWEEP_INTERVAL_MS);
    for (let i = 0; i < 5; i += 1) entries.set(`short${i}`, "s", START + 1_000);
    c.advance(EXPIRED_SWEEP_INTERVAL_MS - 1);
    entries.set("x", "x", START + 10 * EXPIRED_SWEEP_INTERVAL_MS);
    expect(entries.size).toBe(7); // not swept yet: inside the interval
    c.advance(1);
    entries.set("y", "y", START + 10 * EXPIRED_SWEEP_INTERVAL_MS);
    expect(entries.size).toBe(3); // long, x, y
  });

  test("a clock that steps back sweeps at once", () => {
    const c = clock();
    const entries = new ExpiringEntries<string>({ maxEntries: 100, now: c.now });
    entries.set("old", "old", START - 1); // already expired
    c.advance(-1_000);
    entries.set("new", "new", START + 10 * EXPIRED_SWEEP_INTERVAL_MS);
    // The back-step swept, but `old` (expiring at START - 1) is still in the
    // future of the stepped-back clock, so it stays.
    expect(entries.size).toBe(2);
    // One interval after that sweep the next store sweeps again: `old` is gone.
    c.advance(EXPIRED_SWEEP_INTERVAL_MS);
    entries.set("z", "z", START + 10 * EXPIRED_SWEEP_INTERVAL_MS);
    expect(entries.size).toBe(2); // new, z
  });

  test("maxEntries must be an integer ≥ 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ExpiringEntries({ maxEntries: bad, now: Date.now })).toThrow(RangeError);
    }
  });
});

const START_ISO = new Date(START).toISOString();
const KEY = { key_id: "k1", algorithm: "Ed25519", public_key: "pk", created_at: START_ISO };

/** A user-keys transport: every actor publishes k1, cached for an hour. */
function userKeysFetch(now: () => number, calls: string[]): FederationFetch {
  return async (_domain, request) => {
    const handle = decodeURIComponent(new URL(request.url).pathname.split("/")[4] ?? "");
    calls.push(handle);
    return Response.json({
      actor: `${handle}@a.test`,
      keys: [KEY],
      cache_until: new Date(now() + 3_600_000).toISOString(),
    });
  };
}

describe("RemoteUserKeysCache bounds", () => {
  test("maxCachedDocuments: the least recently used actor's document is evicted and re-fetched", async () => {
    const c = clock();
    const calls: string[] = [];
    const cache = new RemoteUserKeysCache({
      federationFetch: userKeysFetch(c.now, calls),
      now: c.now,
      refetchIntervalMs: 0,
      maxCachedDocuments: 2,
    });
    for (const handle of ["r1", "r2", "r1", "r3"]) {
      expect((await cache.lookupActorKey(`${handle}@a.test`, "k1")).kind).toBe("found");
    }
    // r1 was a cache hit (read = use), so r2 was evicted when r3 was stored.
    expect(calls).toEqual(["r1", "r2", "r3"]);
    await cache.lookupActorKey("r1@a.test", "k1");
    await cache.lookupActorKey("r3@a.test", "k1");
    expect(calls).toEqual(["r1", "r2", "r3"]);
    await cache.lookupActorKey("r2@a.test", "k1");
    expect(calls).toEqual(["r1", "r2", "r3", "r2"]);
  });

  test("a body larger than maxDocumentBytes is a fetch failure, streamed or declared", async () => {
    const doc = new TextEncoder().encode(
      JSON.stringify({ actor: "alice@a.test", keys: [KEY], cache_until: START_ISO }),
    );
    let mode: "endless" | "declared" | "exact" = "endless";
    let pulls = 0;
    let cancelled = false;
    const federationFetch: FederationFetch = async () => {
      if (mode === "exact") return new Response(doc, { status: 200 });
      // A body that never ends: only a reader that stops at the limit returns.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(256).fill(0x20));
        },
        cancel() {
          cancelled = true;
        },
      });
      const headers: Record<string, string> =
        mode === "declared" ? { "content-length": "100000" } : {};
      return new Response(body, { status: 200, headers });
    };
    const cache = (maxDocumentBytes: number) =>
      new RemoteUserKeysCache({
        federationFetch,
        refetchIntervalMs: 0,
        now: () => START - 1_000,
        maxDocumentBytes,
      });

    const streamed = await cache(1_000).lookupActorKey("alice@a.test", "k1");
    expect(streamed).toMatchObject({ kind: "fetch_failed" });
    expect((streamed as { reason: string }).reason).toContain("exceeds 1000 bytes");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(Math.ceil(1_000 / 256) + 2); // stopped near the limit

    // A declared Content-Length over the limit is refused before reading.
    mode = "declared";
    cancelled = false;
    pulls = 0;
    const declared = await cache(4_096).lookupActorKey("alice@a.test", "k1");
    expect(declared).toMatchObject({ kind: "fetch_failed" });
    expect((declared as { reason: string }).reason).toContain("exceeds 4096 bytes");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(1); // at most the stream's own first fill

    // A body exactly at the limit is read; one byte less is not.
    mode = "exact";
    expect((await cache(doc.byteLength).lookupActorKey("alice@a.test", "k1")).kind).toBe("found");
    expect((await cache(doc.byteLength - 1).lookupActorKey("alice@a.test", "k1")).kind).toBe(
      "fetch_failed",
    );
  });

  test("an evicted document no longer vouches for the key in lastCompletedFetch", async () => {
    // What the §7.1 key watch relies on: eviction can drop a confirmation
    // (the watch then refreshes on its own), never extend or end one.
    const c = clock();
    const cache = new RemoteUserKeysCache({
      federationFetch: userKeysFetch(c.now, []),
      now: c.now,
      refetchIntervalMs: 0,
      maxCachedDocuments: 1,
    });
    await cache.lookupActorKey("r1@a.test", "k1");
    expect(cache.lastCompletedFetch("r1@a.test", "k1")).toMatchObject({
      key: { keyId: "k1" },
      expiresAt: START + 3_600_000,
    });
    await cache.lookupActorKey("r2@a.test", "k1"); // evicts r1's document
    expect(cache.lastCompletedFetch("r1@a.test", "k1")).toMatchObject({
      key: { keyId: "k1" },
      expiresAt: null,
    });
  });

  test("an invalid option is named in the error", () => {
    expect(() => new RemoteUserKeysCache({ maxCachedDocuments: 0 })).toThrow(/maxCachedDocuments/);
    expect(() => new RemoteDiscoveryCache({ maxCachedDocuments: 0 })).toThrow(/maxCachedDocuments/);
  });

  test("count options must be integers ≥ 1", () => {
    for (const option of ["maxRememberedFetches", "maxCachedDocuments", "maxDocumentBytes"]) {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => new RemoteUserKeysCache({ [option]: bad })).toThrow(RangeError);
      }
      expect(() => new RemoteUserKeysCache({ [option]: 1 })).not.toThrow();
    }
  });
});

describe("RemoteDiscoveryCache bounds", () => {
  let tmp: string;
  /** A valid discovery document, as this server publishes it. */
  let template: { provider: Record<string, unknown> } & Record<string, unknown>;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "forumall-bounds-"));
    const config = loadConfig({
      DATA_DIR: tmp,
      DB_PATH: join(tmp, "self.sqlite"),
      WEB_DIR: join(tmp, "web"),
      DOMAIN: "self.test",
    });
    const db = openDb(config.dbPath);
    migrate(db);
    const app = createApp(config, { testOnlySkipReplayWarmup: true, db });
    template = (await (await app.request("/.well-known/ofscp-provider")).json()) as typeof template;
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Every host answers with the template renamed to itself, cached for an hour. */
  function discoveryFetch(calls: string[], pad = 0): FederationFetch {
    return async (domain) => {
      calls.push(domain);
      return Response.json(
        { ...template, provider: { ...template.provider, domain }, padding: "x".repeat(pad) },
        { headers: { "cache-control": "max-age=3600" } },
      );
    };
  }

  function keyIdOf(): string {
    const keys = template.provider.publicKeys as { key_id: string }[];
    return keys[0]?.key_id ?? "";
  }

  test("maxCachedDocuments: the least recently used provider's document is evicted", async () => {
    const calls: string[] = [];
    const cache = new RemoteDiscoveryCache({
      federationFetch: discoveryFetch(calls),
      refetchIntervalMs: 0,
      maxCachedDocuments: 2,
    });
    for (const host of ["p1.test", "p2.test", "p1.test", "p3.test", "p2.test"]) {
      expect((await cache.lookupProviderKey(host, keyIdOf())).kind).toBe("found");
    }
    expect(calls).toEqual(["p1.test", "p2.test", "p3.test", "p2.test"]);
  });

  test("a body larger than maxDocumentBytes is a fetch failure", async () => {
    const calls: string[] = [];
    const cache = new RemoteDiscoveryCache({
      federationFetch: discoveryFetch(calls, 2_000),
      refetchIntervalMs: 0,
      maxDocumentBytes: 1_000,
    });
    const outcome = await cache.lookupProviderKey("p1.test", keyIdOf());
    expect(outcome).toMatchObject({ kind: "fetch_failed" });
    expect((outcome as { reason: string }).reason).toContain("exceeds 1000 bytes");
  });

  test("count options must be integers ≥ 1", () => {
    for (const option of ["maxCachedDocuments", "maxDocumentBytes"]) {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => new RemoteDiscoveryCache({ [option]: bad })).toThrow(RangeError);
      }
    }
  });
});
