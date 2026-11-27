/**
 * Web Push delivery follows the outbound-request rules (§8 "Outbound
 * requests") and the federation policy (§8 Authorization).
 *
 * A push endpoint is a URL a browser handed us, so every delivery runs through
 * the real egress guard ({@link guardedPushFetch} → `guardedFetch`): `https`
 * only, every resolved address public, redirects returned and never followed.
 * And a push host the policy denies is never contacted, even when the
 * subscription was stored before the host was denied.
 *
 * The guard's resolver and underlying fetch are injected, so nothing here
 * touches the network; the last cases use the production default transport on
 * targets the guard refuses before any network access, with the global `fetch`
 * replaced by a recorder that would accept the push, so an unguarded default
 * would be caught delivering.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Config, loadConfig } from "../src/config.ts";
import { type Db, openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import type { Resolver } from "../src/provider/federation/egress-guard.ts";
import {
  type PushFetch,
  type PushPayload,
  guardedPushFetch,
  sendPushToRecipient,
} from "../src/provider/push-send.ts";
import { addSubscription, listSubscriptions } from "../src/provider/push.ts";
import { withRecordingGlobalFetch } from "./helpers/global-fetch-recorder.ts";

const DOMAIN = "providera.test";
const RECIPIENT = `alice@${DOMAIN}`;
const KEYS = {
  // RFC 8291 §5 receiver keys (valid P-256 point + auth secret).
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const PAYLOAD: PushPayload = {
  title: "t",
  body: "b",
  tag: "x",
  data: { type: "dm", targetUrl: "/dms/x" },
};

let tmp: string;
let n = 0;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-push-egress-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A provider DB holding one push subscription of alice's at `endpoint`. */
function withSubscription(endpoint: string, env: Record<string, string> = {}) {
  n += 1;
  const config: Config = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `p${n}.sqlite`),
    WEB_DIR: join(tmp, `p${n}-web`),
    DOMAIN,
    ...env,
  });
  const db: Db = openDb(config.dbPath);
  migrate(db);
  addSubscription(db, "alice", { endpoint, keys: KEYS });
  return { config, db };
}

/** An underlying fetch that records what reached it and answers `status`. */
function recorder(status = 201, headers: Record<string, string> = {}) {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined; signal: boolean }> = [];
  const fetch = async (req: Request, init: RequestInit) => {
    seen.push({
      url: req.url,
      redirect: init.redirect,
      signal: init.signal instanceof AbortSignal,
    });
    return new Response(null, { status, headers });
  };
  return { fetch, seen };
}

const resolvesTo =
  (...addrs: string[]): Resolver =>
  async () =>
    addrs;

describe("push delivery runs through the egress guard", () => {
  test("a public https endpoint is delivered, without following redirects, under one deadline", async () => {
    const { config, db } = withSubscription("https://push.example.net/sub/1");
    const r = recorder(201);
    const sent = await sendPushToRecipient(
      db,
      config,
      RECIPIENT,
      PAYLOAD,
      guardedPushFetch({ resolve: resolvesTo("93.184.216.34"), fetch: r.fetch }),
    );
    expect(sent).toBe(1);
    expect(r.seen).toEqual([
      { url: "https://push.example.net/sub/1", redirect: "manual", signal: true },
    ]);
  });

  const refused: ReadonlyArray<[string, string, Resolver]> = [
    ["an http endpoint", "http://push.example.net/sub/1", resolvesTo("93.184.216.34")],
    ["a name resolving to loopback", "https://push.example.net/sub/1", resolvesTo("127.0.0.1")],
    [
      "a name resolving to a private address",
      "https://push.example.net/sub/1",
      resolvesTo("10.1.2.3"),
    ],
    [
      "a name with one private address among public ones",
      "https://push.example.net/sub/1",
      resolvesTo("93.184.216.34", "192.168.1.9"),
    ],
    ["the metadata service", "https://push.example.net/sub/1", resolvesTo("169.254.169.254")],
    ["a literal private IP", "https://10.0.0.7/sub/1", resolvesTo("93.184.216.34")],
    ["an IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/sub/1", resolvesTo()],
  ];
  for (const [name, endpoint, resolve] of refused) {
    test(`${name} is never contacted (and the subscription is kept)`, async () => {
      const { config, db } = withSubscription(endpoint);
      const r = recorder(201);
      const sent = await sendPushToRecipient(
        db,
        config,
        RECIPIENT,
        PAYLOAD,
        guardedPushFetch({ resolve, fetch: r.fetch }),
      );
      expect(sent).toBe(0);
      expect(r.seen).toEqual([]);
      expect(listSubscriptions(db, "alice")).toHaveLength(1);
    });
  }

  test("a redirecting endpoint: the 3xx is not followed and counts as a failed delivery", async () => {
    const { config, db } = withSubscription("https://push.example.net/sub/1");
    const r = recorder(307, { location: "https://169.254.169.254/latest/meta-data" });
    const sent = await sendPushToRecipient(
      db,
      config,
      RECIPIENT,
      PAYLOAD,
      guardedPushFetch({ resolve: resolvesTo("93.184.216.34"), fetch: r.fetch }),
    );
    expect(sent).toBe(0);
    expect(r.seen.map((s) => s.url)).toEqual(["https://push.example.net/sub/1"]);
    expect(listSubscriptions(db, "alice")).toHaveLength(1);
  });
});

describe("push delivery follows the federation policy (§8)", () => {
  test("a push host denied after the subscription was stored is never contacted", async () => {
    const { config, db } = withSubscription("https://push.example.net/sub/1", {
      FEDERATION_DENY: "push.example.net",
    });
    let calls = 0;
    const counting: PushFetch = async () => {
      calls += 1;
      return { status: 201 };
    };
    expect(await sendPushToRecipient(db, config, RECIPIENT, PAYLOAD, counting)).toBe(0);
    expect(calls).toBe(0);
  });

  test("a push host outside an allow list is never contacted", async () => {
    const { config, db } = withSubscription("https://push.example.net/sub/1", {
      FEDERATION_ALLOW: "other.example",
    });
    let calls = 0;
    const counting: PushFetch = async () => {
      calls += 1;
      return { status: 201 };
    };
    expect(await sendPushToRecipient(db, config, RECIPIENT, PAYLOAD, counting)).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("the production default transport is the guarded one", () => {
  // The global fetch answers 201, so an unguarded default would deliver (and
  // mark the subscription delivered); the guard refuses before calling it.
  for (const endpoint of ["http://push.example.net/sub/1", "https://127.0.0.1:1/sub/1"]) {
    test(`${endpoint} is refused before any network access`, async () => {
      const { config, db } = withSubscription(endpoint);
      const { result, urls } = await withRecordingGlobalFetch(
        () => new Response(null, { status: 201 }),
        () => sendPushToRecipient(db, config, RECIPIENT, PAYLOAD),
      );
      expect(result).toBe(0);
      expect(urls).toEqual([]);
      expect(listSubscriptions(db, "alice")[0]?.lastDeliveredAt ?? null).toBeNull();
    });
  }
});
