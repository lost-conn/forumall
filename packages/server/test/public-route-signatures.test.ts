/**
 * Signed requests to public routes (OFSCP §4.5 "Anonymous viewers", §8
 * *Authorization*).
 *
 * §8 applies the inbound allow/deny policy to every SIGNED request on every
 * route, public ones included (discovery, the keys endpoint, …), after §4.5
 * steps 1–5 and before any key or discovery fetch; an UNSIGNED request carries
 * no provider identity and is answered as for anyone. §4.5: any `X-OFSCP-*`
 * header makes a request signed and subject to the checks (`401` when they
 * fail), while a request with none of them on an anonymous-reader route is an
 * anonymous viewer, never `401`.
 *
 * Covers, with a deny list set:
 *  - every public route answers an unsigned request as usual;
 *  - a user-signed request from a denied provider → `403` on every route that
 *    accepts unsigned callers (public probes, unsigned-by-design auth routes,
 *    anonymous-reader routes), with no outbound fetch;
 *  - a provider-signed request from a denied provider → `403` on the public
 *    probes (a permitted provider's is `provider-signed-routes.test.ts`);
 *  - steps 1–5 win over the policy (stale timestamp → `401`, digest → `400`),
 *    and a `403`'d request's nonce is not recorded;
 *  - a partial or invalid signature on a public / anonymous-reader route → `401`;
 *  - during the replay warm-up (§4.5 "Restarts") an unsigned probe is still
 *    served while a signed one gets `503`.
 */
import { describe, expect, test } from "bun:test";
import { HEADER, generateKeyPair, rfc3339Timestamp } from "@forumall/shared";

import {
  PUBLIC_200,
  PUBLIC_OTHER,
  type Route,
  type Signer,
  actorHeaders,
  anonymousReaderRoutes,
  freshApp as bootApp,
  deniedActor,
  deniedProviderHeaders,
  expectProblem,
  registerUserWithKey,
  seed,
  send,
  useTmpDir,
} from "./helpers/signed-routes.ts";

const tmp = useTmpDir("forumall-public-sig-");
const freshApp = (opts?: Parameters<typeof bootApp>[1]) => bootApp(tmp(), opts);

describe("unsigned requests are answered regardless of the deny list (§8)", () => {
  test("public routes and anonymous-reader routes → 200", async () => {
    const { app, calls } = freshApp();
    const { groupId, channelId, messageId } = await seed(app);
    for (const route of [...PUBLIC_200, ...anonymousReaderRoutes(groupId, channelId, messageId)]) {
      const res = await send(app, route, {});
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 200 });
    }
    expect(calls).toEqual([]);
  });
});

describe("a signed request naming a denied provider → 403 on every public route (§8)", () => {
  test("user-signed: public probes, unsigned-by-design routes, anonymous readers", async () => {
    const { app, calls } = freshApp();
    const { groupId, channelId, messageId } = await seed(app);
    const mallory = deniedActor();
    const routes = [
      ...PUBLIC_200,
      ...PUBLIC_OTHER,
      ...anonymousReaderRoutes(groupId, channelId, messageId),
    ];
    for (const route of routes) {
      const res = await send(app, route, actorHeaders(mallory, route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 403 });
      expect(((await res.json()) as { errorCode: string }).errorCode).toBe("forbidden");
    }
    // Refused before any key fetch (§4.6 "no fetch is allowed").
    expect(calls).toEqual([]);
  });

  test("provider-signed: public probes and unsigned-by-design routes (deny before the 401)", async () => {
    const { app, calls } = freshApp();
    for (const route of [...PUBLIC_200, ...PUBLIC_OTHER]) {
      const res = await send(app, route, deniedProviderHeaders(route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 403 });
      expect(((await res.json()) as { errorCode: string }).errorCode).toBe("forbidden");
    }
    // Refused before any discovery fetch (§8.1 step 2).
    expect(calls).toEqual([]);
  });

  test("§4.5 steps 1–5 win over the policy, and a 403'd nonce is not recorded", async () => {
    const { app } = freshApp();
    const mallory = deniedActor();
    const route: Route = { method: "GET", path: "/.well-known/ofscp-provider" };

    const stale = rfc3339Timestamp(new Date(Date.now() - 3_600_000));
    await expectProblem(
      await send(app, route, actorHeaders(mallory, route, { timestamp: stale })),
      401,
      "unauthorized",
    );

    const badDigest = { ...actorHeaders(mallory, route), [HEADER.CONTENT_DIGEST]: "AAAA" };
    await expectProblem(await send(app, route, badDigest), 400, "bad_request");

    // The same signed request twice: still 403, never a 401 replay.
    const headers = actorHeaders(mallory, route);
    await expectProblem(await send(app, route, headers), 403, "forbidden");
    await expectProblem(await send(app, route, headers), 403, "forbidden");
  });
});

describe("a signed request that fails §4.5 → 401, never anonymous (§4.5)", () => {
  test("a partial signature header set → 401 on public and anonymous-reader routes", async () => {
    const { app } = freshApp();
    const { groupId, channelId, messageId } = await seed(app);
    for (const route of [...PUBLIC_200, ...anonymousReaderRoutes(groupId, channelId, messageId)]) {
      for (const header of [HEADER.NONCE, HEADER.ACTOR, HEADER.PROVIDER]) {
        const res = await send(app, route, { [header]: "x" });
        expect({ path: route.path, header, status: res.status }).toEqual({
          path: route.path,
          header,
          status: 401,
        });
      }
    }
  });

  test("an invalid signature → 401 on public and anonymous-reader routes", async () => {
    const { app } = freshApp();
    const { alice, groupId, channelId, messageId } = await seed(app);
    const forged: Signer = { ...alice, privateKey: generateKeyPair().privateKey };
    for (const route of [...PUBLIC_200, ...anonymousReaderRoutes(groupId, channelId, messageId)]) {
      const res = await send(app, route, actorHeaders(forged, route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 401 });
    }
  });

  test("a valid local signature is accepted on public routes", async () => {
    const { app } = freshApp();
    const { alice } = await seed(app);
    for (const route of PUBLIC_200) {
      const res = await send(app, route, actorHeaders(alice, route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 200 });
    }
  });
});

describe("the provider's own authority is exempt from its policy (§8)", () => {
  test("an allow list that omits this provider still serves its own signed users", async () => {
    const { app } = freshApp({ policy: { FEDERATION_ALLOW: "friend.example" } });
    const { alice, groupId, channelId, messageId } = await seed(app);
    for (const route of [...PUBLIC_200, ...anonymousReaderRoutes(groupId, channelId, messageId)]) {
      const res = await send(app, route, actorHeaders(alice, route));
      expect({ path: route.path, status: res.status }).toEqual({ path: route.path, status: 200 });
    }
    // …while an actor of a provider not on the allow list is refused.
    const route: Route = { method: "GET", path: "/api/tiers" };
    await expectProblem(
      await send(app, route, actorHeaders(deniedActor(), route)),
      403,
      "forbidden",
    );
  });
});

describe("replay warm-up (§4.5 Restarts)", () => {
  test("an unsigned probe is served during warm-up; a signed one gets 503", async () => {
    const { app } = freshApp({ warmup: true });
    const alice = await registerUserWithKey(app, "alice");
    for (const route of PUBLIC_200) {
      expect((await send(app, route, {})).status).toBe(200);
      const signed = await send(app, route, actorHeaders(alice, route));
      expect(signed.status).toBe(503);
      expect(signed.headers.get("retry-after")).not.toBeNull();
    }
  });
});
