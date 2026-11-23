/**
 * `signedProviderFetch` retry-on-503 (OFSCP §4.5 "Restarts"): a peer in its
 * replay-store warm-up answers 503 + `Retry-After`; an opted-in idempotent send
 * waits that long and RE-SIGNS (fresh timestamp + nonce), giving up once the
 * summed waits would exceed the policy cap.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADER } from "@forumall/shared";

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  BACKGROUND_RETRY,
  type FederationFetch,
  INLINE_RETRY,
  parseRetryAfterMs,
  signedProviderFetch,
} from "../src/provider/federation/http.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-fedretry-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setup(name: string) {
  const config = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN: "providera.test",
  });
  const db = openDb(config.dbPath);
  migrate(db);
  return { config, db };
}

/** A peer that answers each request from `script` in turn, recording requests. */
function scriptedPeer(script: (() => Response)[]) {
  const seen: Request[] = [];
  const fetch: FederationFetch = async (_domain, req) => {
    seen.push(req);
    const next = script[Math.min(seen.length - 1, script.length - 1)] as () => Response;
    return next();
  };
  return { fetch, seen };
}

const warmup = (seconds: number | string) => () =>
  new Response('{"errorCode":"service_unavailable"}', {
    status: 503,
    headers: { "retry-after": String(seconds) },
  });
const ok = () => new Response("{}", { status: 200 });

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

const URL_B = "https://providerb.test/api/federation/dms/dm_1/messages/m_1";

describe("signedProviderFetch retry on 503 + Retry-After", () => {
  test("waits Retry-After, then re-signs with a fresh nonce and succeeds", async () => {
    const { config, db } = setup("resign");
    const peer = scriptedPeer([warmup(2), ok]);
    const { waits, sleep } = recordingSleep();
    const res = await signedProviderFetch(
      db,
      config,
      { method: "DELETE", url: URL_B, retry: { maxTotalWaitMs: 10_000, sleep } },
      peer.fetch,
    );
    expect(res.status).toBe(200);
    expect(waits).toEqual([2_000]);
    expect(peer.seen.length).toBe(2);
    const [a, b] = peer.seen as [Request, Request];
    expect(a.headers.get(HEADER.NONCE)).not.toBe(b.headers.get(HEADER.NONCE));
    expect(a.headers.get(HEADER.SIGNATURE)).not.toBe(b.headers.get(HEADER.SIGNATURE));
  });

  test("gives up (returning the 503) once the next wait would exceed the cap", async () => {
    const { config, db } = setup("cap");
    const peer = scriptedPeer([warmup(300)]);
    const { waits, sleep } = recordingSleep();
    const res = await signedProviderFetch(
      db,
      config,
      { method: "PUT", url: URL_B, retry: { ...BACKGROUND_RETRY, sleep } },
      peer.fetch,
    );
    expect(res.status).toBe(503);
    // 300s fits the 360s background cap once; a second 300s would not.
    expect(waits).toEqual([300_000]);
    expect(peer.seen.length).toBe(2);
  });

  test("the inline (user-waiting) cap does not wait out a long warm-up", async () => {
    const { config, db } = setup("inline");
    const peer = scriptedPeer([warmup(120), ok]);
    const { waits, sleep } = recordingSleep();
    const res = await signedProviderFetch(
      db,
      config,
      { method: "PATCH", url: URL_B, retry: { ...INLINE_RETRY, sleep } },
      peer.fetch,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("120"); // relayable to the client
    expect(waits).toEqual([]);
    expect(peer.seen.length).toBe(1);
  });

  test("stops after maxAttempts", async () => {
    const { config, db } = setup("attempts");
    const peer = scriptedPeer([warmup(1)]);
    const { waits, sleep } = recordingSleep();
    const res = await signedProviderFetch(
      db,
      config,
      { method: "PUT", url: URL_B, retry: { maxTotalWaitMs: 60_000, maxAttempts: 3, sleep } },
      peer.fetch,
    );
    expect(res.status).toBe(503);
    expect(peer.seen.length).toBe(3);
    expect(waits).toEqual([1_000, 1_000]);
  });

  test("no retry without a policy, without Retry-After, or with a pinned nonce", async () => {
    const { config, db } = setup("noretry");
    const { waits, sleep } = recordingSleep();

    let peer = scriptedPeer([warmup(1), ok]);
    expect(
      (await signedProviderFetch(db, config, { method: "PUT", url: URL_B }, peer.fetch)).status,
    ).toBe(503);
    expect(peer.seen.length).toBe(1);

    peer = scriptedPeer([() => new Response(null, { status: 503 }), ok]);
    const noHeader = await signedProviderFetch(
      db,
      config,
      { method: "PUT", url: URL_B, retry: { maxTotalWaitMs: 60_000, sleep } },
      peer.fetch,
    );
    expect(noHeader.status).toBe(503);
    expect(peer.seen.length).toBe(1);

    peer = scriptedPeer([warmup(1), ok]);
    const pinned = await signedProviderFetch(
      db,
      config,
      { method: "PUT", url: URL_B, nonce: "fixed", retry: { maxTotalWaitMs: 60_000, sleep } },
      peer.fetch,
    );
    expect(pinned.status).toBe(503);
    expect(peer.seen.length).toBe(1);
    expect(waits).toEqual([]);
  });

  test("parseRetryAfterMs: delta-seconds and HTTP-date", () => {
    const now = Date.parse("2026-06-01T12:00:00Z");
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs("Mon, 01 Jun 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });
});
