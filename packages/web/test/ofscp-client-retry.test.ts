/**
 * OfscpClient retry on `503` + `Retry-After` (OFSCP §4.5 "Restarts": a provider
 * in its replay-store warm-up). Idempotent requests are retried after the
 * requested wait and RE-SIGNED each time; past the short user-facing cap the
 * 503 surfaces as an OfscpHttpError with a clear message + `retryAfterSeconds`.
 */
import { describe, expect, test } from "bun:test";
import { HEADER, generateKeyPair } from "@forumall/shared";

import { OfscpClient, OfscpHttpError } from "../src/lib/ofscp-client.ts";

const warmup = (seconds: number) =>
  new Response(JSON.stringify({ errorCode: "service_unavailable", detail: "warming up" }), {
    status: 503,
    headers: { "content-type": "application/problem+json", "retry-after": String(seconds) },
  });
const ok = () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

function harness(script: (() => Response)[], retryMaxWaitMs?: number) {
  const calls: { method: string; headers: Record<string, string> }[] = [];
  const waits: number[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), headers: init.headers as Record<string, string> });
    const next = script[Math.min(calls.length - 1, script.length - 1)] as () => Response;
    return next();
  }) as unknown as typeof fetch;
  const client = new OfscpClient({
    baseUrl: "https://providera.com",
    actor: "alice@providera.com",
    keyId: "key_1",
    privateKey: generateKeyPair().privateKey,
    fetch: fakeFetch,
    sleep: async (ms) => void waits.push(ms),
    ...(retryMaxWaitMs !== undefined ? { retryMaxWaitMs } : {}),
  });
  return { client, calls, waits };
}

describe("OfscpClient: 503 + Retry-After", () => {
  test("GET is retried after Retry-After and re-signed with a fresh nonce", async () => {
    const h = harness([() => warmup(3), ok]);
    const res = await h.client.get("/api/me/dms");
    expect(res.status).toBe(200);
    expect(h.waits).toEqual([3_000]);
    expect(h.calls.length).toBe(2);
    const [a, b] = h.calls as [(typeof h.calls)[0], (typeof h.calls)[0]];
    expect(a.headers[HEADER.NONCE]).toBeDefined();
    expect(a.headers[HEADER.NONCE]).not.toBe(b.headers[HEADER.NONCE]);
    expect(a.headers[HEADER.SIGNATURE]).not.toBe(b.headers[HEADER.SIGNATURE]);
  });

  test("gives up past the cap with a clear message and retryAfterSeconds", async () => {
    const h = harness([() => warmup(240)]); // default cap: 15s
    const err = await h.client.get("/api/me/dms").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfscpHttpError);
    const e = err as OfscpHttpError;
    expect(e.status).toBe(503);
    expect(e.retryAfterSeconds).toBe(240);
    expect(e.message).toContain("temporarily unavailable");
    expect(e.message).toContain("4 minutes");
    expect(h.calls.length).toBe(1);
    expect(h.waits).toEqual([]);
  });

  test("summed waits are capped: retries while they fit, then gives up", async () => {
    const h = harness([() => warmup(6)], 15_000);
    const err = await h.client.get("/api/x").catch((e: unknown) => e);
    expect((err as OfscpHttpError).status).toBe(503);
    expect(h.waits).toEqual([6_000, 6_000]); // a third 6s would exceed 15s
    expect(h.calls.length).toBe(3);
  });

  test("a plain POST is not retried; an idempotent one is", async () => {
    const plain = harness([() => warmup(1), ok]);
    const err = await plain.client.post("/api/groups", { name: "g" }).catch((e: unknown) => e);
    expect((err as OfscpHttpError).status).toBe(503);
    expect(plain.calls.length).toBe(1);

    const keyed = harness([() => warmup(1), ok]);
    const res = await keyed.client.post(
      "/api/federation/dms/dm_1/messages",
      { clientMessageId: "c1", content: { mime: "text/plain", text: "hi" } },
      { idempotent: true },
    );
    expect(res.status).toBe(200);
    expect(keyed.calls.length).toBe(2);
    expect(keyed.waits).toEqual([1_000]);
  });

  test("a 503 without Retry-After is not retried", async () => {
    const h = harness([() => new Response(null, { status: 503 }), ok]);
    const err = await h.client.get("/api/x").catch((e: unknown) => e);
    expect((err as OfscpHttpError).status).toBe(503);
    expect((err as OfscpHttpError).retryAfterSeconds).toBeUndefined();
    expect(h.calls.length).toBe(1);
  });
});
