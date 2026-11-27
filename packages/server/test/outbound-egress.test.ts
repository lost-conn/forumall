/**
 * Notification-target delivery (§10) and the known-providers scrape (§8.6)
 * follow the outbound-request rules (§8 "Outbound requests") end to end.
 *
 * Both send to a host someone else named (a user's webhook `target`, a peer
 * domain) through the app's {@link FederationFetch}, whose production default
 * is the egress guard. Here that transport is the REAL `guardedFetch` with an
 * injected resolver and underlying fetch (no network): `https` only, every
 * resolved address public, a `3xx` returned and never followed. The last cases
 * use the production default transport on targets the guard refuses before any
 * network access.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Config, loadConfig } from "../src/config.ts";
import { type Db, openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { type Resolver, guardedFetch } from "../src/provider/federation/egress-guard.ts";
import {
  type FederationFetch,
  defaultFederationFetch,
  withFederationPolicy,
} from "../src/provider/federation/http.ts";
import { listKnownProviders, scrapeKnownProviders } from "../src/provider/known-providers.ts";
import { deliverNotification, registerEndpoint } from "../src/provider/notifications.ts";

const DOMAIN = "providera.test";
const PUBLIC = "93.184.216.34";

let tmp: string;
let n = 0;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-outbound-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function provider(env: Record<string, string> = {}): { config: Config; db: Db } {
  n += 1;
  const config = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `p${n}.sqlite`),
    WEB_DIR: join(tmp, `p${n}-web`),
    DOMAIN,
    ...env,
  });
  const db = openDb(config.dbPath);
  migrate(db);
  return { config, db };
}

/**
 * The app's transport shape — policy over the real egress guard — with an
 * injected resolver and an underlying fetch that records what reached it.
 */
function guarded(
  config: Config,
  resolve: Resolver,
  respond: (req: Request) => Response = () => new Response(null, { status: 202 }),
) {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const transport: FederationFetch = (_domain, request) =>
    guardedFetch(request, {
      resolve,
      timeoutMs: 1_000,
      fetch: async (req, init) => {
        seen.push({ url: req.url, redirect: init.redirect });
        return respond(req);
      },
    });
  return { federationFetch: withFederationPolicy(config, transport), seen };
}

const resolvesTo =
  (...addrs: string[]): Resolver =>
  async () =>
    addrs;

/** One webhook endpoint of alice's at `target`, subscribed to `message.created`. */
function withWebhook(target: string, env: Record<string, string> = {}) {
  const p = provider(env);
  registerEndpoint(p.db, "alice", { type: "webhook", target, events: ["message.created"] });
  return p;
}

const EVENT = { event: "message.created", resource: { id: "msg_1", channel: "ch_1" } };

describe("notification-target delivery (§10) obeys the outbound-request rules", () => {
  test("a public https target is delivered, redirects not followed", async () => {
    const { config, db } = withWebhook("https://hooks.example.net/in");
    const t = guarded(config, resolvesTo(PUBLIC));
    const [result] = await deliverNotification(db, config, t.federationFetch, EVENT);
    expect(result?.ok).toBe(true);
    expect(t.seen).toEqual([{ url: "https://hooks.example.net/in", redirect: "manual" }]);
  });

  const refused: ReadonlyArray<[string, string, Resolver]> = [
    ["an http target", "http://hooks.example.net/in", resolvesTo(PUBLIC)],
    ["a target resolving to loopback", "https://hooks.example.net/in", resolvesTo("127.0.0.1")],
    [
      "a target resolving to a private address",
      "https://hooks.example.net/in",
      resolvesTo("10.9.8.7"),
    ],
    ["a target resolving to link-local", "https://hooks.example.net/in", resolvesTo("fe80::1")],
    ["a literal private IP target", "https://192.168.0.10/in", resolvesTo(PUBLIC)],
  ];
  for (const [name, target, resolve] of refused) {
    test(`${name} is never contacted`, async () => {
      const { config, db } = withWebhook(target);
      const t = guarded(config, resolve);
      const [result] = await deliverNotification(db, config, t.federationFetch, EVENT);
      expect(result?.ok).toBe(false);
      expect(t.seen).toEqual([]);
    });
  }

  test("a redirecting target: the 3xx is not followed and the delivery failed", async () => {
    const { config, db } = withWebhook("https://hooks.example.net/in");
    const t = guarded(
      config,
      resolvesTo(PUBLIC),
      () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/admin" } }),
    );
    const [result] = await deliverNotification(db, config, t.federationFetch, EVENT);
    expect(result).toMatchObject({ ok: false, status: 302 });
    expect(t.seen.map((s) => s.url)).toEqual(["https://hooks.example.net/in"]);
  });

  test("a target whose host the policy denies is never contacted", async () => {
    const { config, db } = withWebhook("https://hooks.example.net/in", {
      FEDERATION_DENY: "hooks.example.net",
    });
    const t = guarded(config, resolvesTo(PUBLIC));
    const [result] = await deliverNotification(db, config, t.federationFetch, EVENT);
    expect(result?.ok).toBe(false);
    expect(t.seen).toEqual([]);
  });

  test("the production default transport refuses a private literal before any network access", async () => {
    const { config, db } = withWebhook("https://127.0.0.1:1/in");
    const started = performance.now();
    const [result] = await deliverNotification(
      db,
      config,
      withFederationPolicy(config, defaultFederationFetch),
      EVENT,
    );
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("non-public");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("the known-providers scrape (§8.6) obeys the outbound-request rules", () => {
  const providersDoc = () =>
    Response.json({ providers: [{ domain: "third.example", name: "Third" }], metadata: [] });

  test("a public peer is scraped, redirects not followed", async () => {
    const { config, db } = provider();
    const t = guarded(config, resolvesTo(PUBLIC), providersDoc);
    const added = await scrapeKnownProviders(db, config, "peer.example", t.federationFetch);
    expect(added.sort()).toEqual(["peer.example", "third.example"]);
    expect(t.seen).toEqual([{ url: "https://peer.example/api/providers", redirect: "manual" }]);
  });

  test("a peer resolving to a private address is never contacted, nothing recorded", async () => {
    const { config, db } = provider();
    const t = guarded(config, resolvesTo("172.16.0.4"), providersDoc);
    expect(await scrapeKnownProviders(db, config, "peer.example", t.federationFetch)).toEqual([]);
    expect(t.seen).toEqual([]);
    expect(listKnownProviders(db)).toEqual([]);
  });

  test("a redirecting peer: the 3xx is not followed, nothing recorded", async () => {
    const { config, db } = provider();
    const t = guarded(
      config,
      resolvesTo(PUBLIC),
      () => new Response(null, { status: 301, headers: { location: "https://127.0.0.1/" } }),
    );
    expect(await scrapeKnownProviders(db, config, "peer.example", t.federationFetch)).toEqual([]);
    expect(t.seen).toHaveLength(1);
    expect(listKnownProviders(db)).toEqual([]);
  });

  test("the production default transport refuses a private literal peer", async () => {
    const { config, db } = provider();
    expect(await scrapeKnownProviders(db, config, "127.0.0.1:1")).toEqual([]);
    expect(listKnownProviders(db)).toEqual([]);
  });
});
