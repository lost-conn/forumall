/**
 * Signer identity on routes that do not take it (OFSCP §4.4.1, §4.5 step 1,
 * §8 *Authorization*, §8.1, §4.5 "Restarts"; lost-conn/ofscp#38, #42).
 *
 *  - A request carrying BOTH `X-OFSCP-Actor` and `X-OFSCP-Provider` is
 *    malformed: `401` at §4.5 step 1, whichever provider either header names —
 *    the deny `403` never replaces it.
 *  - No route of the spec accepts provider-signed requests. A provider-signed
 *    request to one passes or fails §4.5 steps 1–5, then gets the deny `403`
 *    (denied provider) or `401` (permitted provider): no discovery fetch, no
 *    signature verification, no nonce recorded, and never an anonymous viewer.
 *    That holds on public, anonymous-reader and user-only routes alike.
 *  - Those unverified answers come before the replay warm-up `503`, which
 *    applies only to a request the provider would go on to verify.
 *  - Symmetrically, a user signature on a provider-signed receiver is `401`
 *    unverified; a provider signature there still verifies.
 */
import { describe, expect, test } from "bun:test";
import { HEADER, rfc3339Timestamp } from "@forumall/shared";

import { requireProviderSignature } from "../src/http/signature.ts";
import { getProviderSigningKey } from "../src/provider/signing-key.ts";
import {
  DENIED,
  DOMAIN,
  PERMITTED,
  PUBLIC_200,
  PUBLIC_OTHER,
  type Route,
  actorHeaders,
  anonymousReaderRoutes,
  freshApp as bootApp,
  deniedActor,
  deniedProviderHeaders,
  expectProblem,
  providerHeaders,
  registerUserWithKey,
  seed,
  send,
  useTmpDir,
  userOnlyRoutes,
  withBadDigest,
} from "./helpers/signed-routes.ts";

const tmp = useTmpDir("forumall-provider-sig-");
const freshApp = (opts?: Parameters<typeof bootApp>[1]) => bootApp(tmp(), opts);
type Booted = ReturnType<typeof freshApp>;

/** A route on the §8.3 ingest that takes either signer (`requireActorOrProviderSignature`). */
const EITHER_ROUTE: Route = { method: "DELETE", path: "/api/federation/dms/dm_x/messages/msg_x" };

/** A provider-signed receiver (`requireProviderSignature`), mounted for the test. */
const PROVIDER_ROUTE: Route = { method: "GET", path: "/api/test/provider-probe" };

function mountProviderProbe(booted: Booted): void {
  booted.app.get(PROVIDER_ROUTE.path, requireProviderSignature(), (c) => c.json({ ok: true }));
}

/** Every route that does not take provider signatures, over a seeded provider. */
async function seededRoutes(booted: Booted) {
  const seeded = await seed(booted.app);
  const { groupId, channelId, messageId } = seeded;
  const routes = {
    public: [...PUBLIC_200, ...PUBLIC_OTHER],
    anonymousReader: anonymousReaderRoutes(groupId, channelId, messageId),
    userOnly: userOnlyRoutes(groupId),
  };
  return {
    ...seeded,
    routes,
    all: [...routes.public, ...routes.anonymousReader, ...routes.userOnly],
  };
}

/** Sends each route with `headersFor(route)` and expects `status` + `errorCode`. */
async function expectEach(
  booted: Booted,
  routes: Route[],
  headersFor: (route: Route) => Record<string, string>,
  status: number,
  errorCode: string,
): Promise<void> {
  for (const route of routes) {
    const res = await send(booted.app, route, headersFor(route));
    const body = (await res.json()) as { errorCode?: string };
    expect({ route, status: res.status, errorCode: body.errorCode }).toEqual({
      route,
      status,
      errorCode,
    });
  }
}

/** No outbound fetch (discovery / keys) and no provider nonce recorded. */
function expectUntouched(booted: Booted): void {
  expect(booted.calls).toEqual([]);
  expect(booted.nonces.remembered.filter((k) => k.startsWith("provider:"))).toEqual([]);
}

describe("both identity headers → step-1 401 (§4.5 step 1, §4.4.1)", () => {
  test("on public, anonymous-reader, user-only, either-signer and provider routes", async () => {
    const booted = freshApp();
    mountProviderProbe(booted);
    const { alice, all } = await seededRoutes(booted);
    const routes = [...all, EITHER_ROUTE, PROVIDER_ROUTE];
    const remembered = booted.nonces.remembered.length;

    // A valid user signature plus a provider header — permitted or denied.
    for (const provider of [PERMITTED, DENIED, DOMAIN]) {
      await expectEach(
        booted,
        routes,
        (r) => ({ ...actorHeaders(alice, r), [HEADER.PROVIDER]: provider }),
        401,
        "unauthorized",
      );
    }
    // A provider signature plus an actor header, naming a denied provider in
    // either slot: still 401, never the deny 403.
    await expectEach(
      booted,
      routes,
      (r) => ({ ...providerHeaders(PERMITTED, r), [HEADER.ACTOR]: deniedActor().actor }),
      401,
      "unauthorized",
    );
    await expectEach(
      booted,
      routes,
      (r) => ({ ...deniedProviderHeaders(r), [HEADER.ACTOR]: alice.actor }),
      401,
      "unauthorized",
    );
    expect(booted.calls).toEqual([]);
    expect(booted.nonces.remembered.length).toBe(remembered);
  });
});

describe("a provider signature on a route that does not take one (§8 Authorization)", () => {
  test("a permitted provider → 401 on every route, with no fetch or nonce", async () => {
    const booted = freshApp();
    const { all } = await seededRoutes(booted);
    await expectEach(booted, all, (r) => providerHeaders(PERMITTED, r), 401, "unauthorized");
    expectUntouched(booted);
  });

  test("a valid signature by this provider's own key → 401: never verified, never anonymous", async () => {
    const booted = freshApp();
    const { all } = await seededRoutes(booted);
    const key = getProviderSigningKey(booted.db);
    const own = (r: Route) =>
      providerHeaders(DOMAIN, r, { keyId: key.keyId, privateKey: key.privateKey });
    await expectEach(booted, all, own, 401, "unauthorized");
    expectUntouched(booted);
  });

  test("a denied provider → 403 on every route, user-only ones included", async () => {
    const booted = freshApp();
    const { all } = await seededRoutes(booted);
    await expectEach(booted, all, deniedProviderHeaders, 403, "forbidden");
    expectUntouched(booted);
  });

  test("§4.5 steps 1–5 still come first: stale timestamp → 401, digest → 400", async () => {
    const booted = freshApp();
    const { all } = await seededRoutes(booted);
    const stale = rfc3339Timestamp(new Date(Date.now() - 3_600_000));
    for (const provider of [PERMITTED, DENIED]) {
      await expectEach(
        booted,
        all,
        (r) => providerHeaders(provider, r, { timestamp: stale }),
        401,
        "unauthorized",
      );
      await expectEach(
        booted,
        all,
        (r) => withBadDigest(providerHeaders(provider, r)),
        400,
        "bad_request",
      );
    }
    expectUntouched(booted);
  });

  test("the same provider-signed request twice keeps its answer (its nonce was never recorded)", async () => {
    const booted = freshApp();
    const route: Route = { method: "GET", path: "/api/tiers" };
    const permitted = providerHeaders(PERMITTED, route);
    const denied = deniedProviderHeaders(route);
    for (let i = 0; i < 2; i++) {
      await expectProblem(await send(booted.app, route, permitted), 401, "unauthorized");
      await expectProblem(await send(booted.app, route, denied), 403, "forbidden");
    }
    expectUntouched(booted);
  });
});

describe("a user signature on a provider-signed receiver (§8.1)", () => {
  test("a local user → 401 unverified; a denied actor → 403; a provider still verifies", async () => {
    const booted = freshApp();
    mountProviderProbe(booted);
    const alice = await registerUserWithKey(booted.app, "alice");
    const remembered = booted.nonces.remembered.length;
    await expectProblem(
      await send(booted.app, PROVIDER_ROUTE, actorHeaders(alice, PROVIDER_ROUTE)),
      401,
      "unauthorized",
    );
    await expectProblem(
      await send(booted.app, PROVIDER_ROUTE, actorHeaders(deniedActor(), PROVIDER_ROUTE)),
      403,
      "forbidden",
    );
    expect(booted.nonces.remembered.length).toBe(remembered);

    const key = getProviderSigningKey(booted.db);
    const own = providerHeaders(DOMAIN, PROVIDER_ROUTE, {
      keyId: key.keyId,
      privateKey: key.privateKey,
    });
    expect((await send(booted.app, PROVIDER_ROUTE, own)).status).toBe(200);
    expect(booted.nonces.remembered).toContain(`provider:${key.keyId} ${own[HEADER.NONCE]}`);
  });
});

describe("unverified answers precede the replay warm-up 503 (§4.5 Restarts)", () => {
  test("permitted provider 401, denied provider 403, both headers 401 — never 503", async () => {
    const booted = freshApp({ warmup: true });
    // Seeding signs requests, so it cannot run inside the warm-up; these
    // routes need no seeded rows to reach the signature middleware.
    const routes = [
      ...PUBLIC_200,
      ...PUBLIC_OTHER,
      ...anonymousReaderRoutes("grp_x", "ch_x", "msg_x"),
      ...userOnlyRoutes("grp_x"),
    ];
    const alice = await registerUserWithKey(booted.app, "alice");
    await expectEach(booted, routes, (r) => providerHeaders(PERMITTED, r), 401, "unauthorized");
    await expectEach(booted, routes, deniedProviderHeaders, 403, "forbidden");
    await expectEach(booted, routes, (r) => actorHeaders(deniedActor(), r), 403, "forbidden");
    await expectEach(
      booted,
      routes,
      (r) => ({ ...actorHeaders(alice, r), [HEADER.PROVIDER]: DENIED }),
      401,
      "unauthorized",
    );
    expectUntouched(booted);
  });

  test("a request failing §4.5 steps 1–5 keeps its answer; only a verifiable one gets 503", async () => {
    const booted = freshApp({ warmup: true });
    const alice = await registerUserWithKey(booted.app, "alice");
    const routes = [
      { method: "GET", path: "/api/tiers" },
      { method: "GET", path: "/api/groups/grp_x" },
      { method: "GET", path: "/api/auth/device-keys" },
    ] satisfies Route[];
    await expectEach(
      booted,
      routes,
      (r) => withBadDigest(actorHeaders(alice, r)),
      400,
      "bad_request",
    );
    for (const route of routes) {
      const res = await send(booted.app, route, actorHeaders(alice, route));
      expect({ route, status: res.status }).toEqual({ route, status: 503 });
      expect(res.headers.get("retry-after")).not.toBeNull();
    }
    expect(booted.nonces.remembered).toEqual([]);
  });

  test("a provider signature on the either-signer route is still verified, so it 503s", async () => {
    const booted = freshApp({ warmup: true });
    const key = getProviderSigningKey(booted.db);
    const own = providerHeaders(DOMAIN, EITHER_ROUTE, {
      keyId: key.keyId,
      privateKey: key.privateKey,
    });
    await expectProblem(await send(booted.app, EITHER_ROUTE, own), 503, "service_unavailable");
  });
});
