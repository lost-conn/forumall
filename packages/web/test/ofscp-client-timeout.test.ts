/**
 * OfscpClient `timeoutMs`: a bound on the whole request. A request that hangs
 * is aborted with a `TimeoutError`, which is an unknown outcome, never a
 * definitive rejection.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPair } from "@forumall/shared";

import { OfscpClient, isDefinitiveRejection } from "../src/lib/ofscp-client.ts";

/** A fetch that never answers, rejecting only when its signal aborts. */
function hangingFetch(seen: (AbortSignal | undefined)[]): typeof fetch {
  return ((_url: string, init: RequestInit) => {
    const signal = init.signal ?? undefined;
    seen.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch, sleep?: (ms: number, s?: AbortSignal) => Promise<void>) {
  return new OfscpClient({
    baseUrl: "https://providera.com",
    actor: "alice@providera.com",
    keyId: "key_1",
    privateKey: generateKeyPair().privateKey,
    fetch: fetchImpl,
    ...(sleep ? { sleep } : {}),
  });
}

describe("OfscpClient: timeoutMs", () => {
  test("a hung request is aborted with a TimeoutError: an unknown outcome", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const started = Date.now();
    const err = await client(hangingFetch(seen))
      .patch("/api/x", { a: 1 }, { timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("TimeoutError");
    expect(isDefinitiveRejection(err)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seen[0]?.aborted).toBe(true);
  });

  test("without timeoutMs no deadline signal is added", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      seen.push(init.signal ?? undefined);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await client(ok).get("/api/x");
    expect(seen).toEqual([undefined]);
  });

  test("the caller's own signal still aborts a bounded request", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const caller = new AbortController();
    const pending = client(hangingFetch(seen))
      .get("/api/x", { timeoutMs: 60_000, signal: caller.signal })
      .catch((e: unknown) => e);
    caller.abort(new DOMException("gone", "AbortError"));
    const err = await pending;
    expect((err as DOMException).name).toBe("AbortError");
  });

  test("the deadline covers Retry-After waits too", async () => {
    const warmup = (async () =>
      new Response("{}", {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      })) as unknown as typeof fetch;
    const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    const err = await client(warmup, sleep)
      .get("/api/x", { timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("TimeoutError");
  });

  test("a non-positive timeout is refused", async () => {
    const err = await client(hangingFetch([]))
      .get("/api/x", { timeoutMs: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
  });
});
