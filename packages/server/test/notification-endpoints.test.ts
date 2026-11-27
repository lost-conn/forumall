/**
 * Managing notification endpoints (spec §10 "Managing endpoints"): all three
 * routes are signed and act only on the caller's own endpoints.
 *  - `GET /api/notifications/endpoints` → `{ endpoints: [{ id, type, target, events }] }`
 *    listing the caller's endpoints only (validated against the OFSCP schema);
 *  - `DELETE /api/notifications/endpoints/{id}` → `204`, and `404` when the
 *    caller has no such endpoint (unknown, already deleted, or another user's,
 *    which stays in place).
 * Registration and delivery are covered by `notifications.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  type App,
  type Signer,
  registerUserWithKey,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";
import { makeOfscpCompiler } from "./helpers/ofscp-schemas.ts";

const freshApp = useMembershipApp("notif-endpoints");
const compile = makeOfscpCompiler();

interface Endpoint {
  id: string;
  type: string;
  target: string;
  events: string[];
}

async function register(app: App, signer: Signer, target: string, events: string[]) {
  const res = await signedRequest(app, signer, "POST", "/api/notifications/endpoints", {
    type: "webpush",
    target,
    events,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Endpoint;
}

async function list(app: App, signer: Signer): Promise<Endpoint[]> {
  const res = await signedRequest(app, signer, "GET", "/api/notifications/endpoints");
  expect(res.status).toBe(200);
  const body = await res.json();
  const validate = await compile("notifications-endpoints-response.json");
  expect(validate(body)).toBe(true);
  return (body as { endpoints: Endpoint[] }).endpoints;
}

describe("GET /api/notifications/endpoints (§10)", () => {
  test("lists exactly the caller's own endpoints, as registered", async () => {
    const { app } = freshApp("list");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");

    expect(await list(app, alice)).toEqual([]);

    const a1 = await register(app, alice, "https://push.example/a1", ["message.created"]);
    const a2 = await register(app, alice, "https://push.example/a2", [
      "message.created",
      "call.started",
    ]);
    const b1 = await register(app, bob, "https://push.example/b1", ["message.created"]);

    const aliceList = await list(app, alice);
    expect(aliceList.map((e) => e.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(aliceList.find((e) => e.id === a2.id)).toMatchObject({
      id: a2.id,
      type: "webpush",
      target: "https://push.example/a2",
      events: ["message.created", "call.started"],
    });
    expect(await list(app, bob)).toEqual([b1]);
  });

  test("unsigned → 401", async () => {
    const { app } = freshApp("list-unsigned");
    const res = await app.request("/api/notifications/endpoints");
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/notifications/endpoints/{id} (§10)", () => {
  test("removes the caller's endpoint → 204; a repeat → 404", async () => {
    const { app } = freshApp("delete");
    const alice = await registerUserWithKey(app, "alice");
    const keep = await register(app, alice, "https://push.example/keep", ["message.created"]);
    const gone = await register(app, alice, "https://push.example/gone", ["message.created"]);

    const del = await signedRequest(
      app,
      alice,
      "DELETE",
      `/api/notifications/endpoints/${gone.id}`,
    );
    expect(del.status).toBe(204);
    expect(await list(app, alice)).toEqual([keep]);

    const again = await signedRequest(
      app,
      alice,
      "DELETE",
      `/api/notifications/endpoints/${gone.id}`,
    );
    expect(again.status).toBe(404);
  });

  test("another user's endpoint → 404 and it is left in place; an unknown id → 404", async () => {
    const { app } = freshApp("delete-other");
    const alice = await registerUserWithKey(app, "alice");
    const bob = await registerUserWithKey(app, "bob");
    const bobs = await register(app, bob, "https://push.example/bob", ["message.created"]);

    const res = await signedRequest(
      app,
      alice,
      "DELETE",
      `/api/notifications/endpoints/${bobs.id}`,
    );
    expect(res.status).toBe(404);
    expect(await list(app, bob)).toEqual([bobs]);

    const unknown = await signedRequest(
      app,
      alice,
      "DELETE",
      "/api/notifications/endpoints/nep_doesnotexist",
    );
    expect(unknown.status).toBe(404);
  });

  test("unsigned → 401 and nothing is removed", async () => {
    const { app } = freshApp("delete-unsigned");
    const alice = await registerUserWithKey(app, "alice");
    const ep = await register(app, alice, "https://push.example/a", ["message.created"]);
    const res = await app.request(`/api/notifications/endpoints/${ep.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(await list(app, alice)).toEqual([ep]);
  });
});
