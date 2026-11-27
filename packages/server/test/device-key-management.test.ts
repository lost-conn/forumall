/**
 * Bootstrap-token scope (§4.2), device-key listing and revocation over HTTP
 * (§4.7), and the 32-byte key rule for every submitted key (§4.3.2): device-key
 * registration and guest creation (§4.8).
 *
 *  - A bootstrap token authorizes `POST /api/auth/device-keys` and nothing
 *    else: sent as a Bearer credential to any other endpoint it is refused
 *    (`401`) and stays usable for its one registration. Tokens carry ≥128 bits
 *    from a CSPRNG.
 *  - `GET /api/auth/device-keys` lists the caller's own active keys with every
 *    §4.7 field and validates against `device-keys-response.json`; registration
 *    responses validate against their schemas; `DELETE` revokes (`204`), after
 *    which the key neither lists nor verifies.
 *  - A submitted key that does not decode to exactly 32 bytes is a `400`, on
 *    guest creation as on registration, and provisions nothing.
 */
import { describe, expect, test } from "bun:test";
import { type AuthBootstrapResponse, generateKeyPair } from "@forumall/shared";

import {
  type App,
  DOMAIN,
  type Signer,
  createGroup,
  registerUserWithKey,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";
import { makeOfscpCompiler } from "./helpers/ofscp-schemas.ts";

const freshApp = useMembershipApp("devkey-mgmt");
const compile = makeOfscpCompiler();

async function expectSchema(schemaFile: string, body: unknown): Promise<void> {
  const validate = await compile(schemaFile);
  if (!validate(body)) {
    throw new Error(`${schemaFile}: ${JSON.stringify(validate.errors)}`);
  }
}

async function register(app: App, handle: string): Promise<AuthBootstrapResponse> {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as AuthBootstrapResponse;
}

function postDeviceKey(app: App, token: string, body: Record<string, unknown>) {
  return app.request("/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** Thirty-two bytes is the only valid length; these submitted keys are not it. */
const BAD_KEYS: ReadonlyArray<[string, string]> = [
  ["16 bytes", Buffer.from(new Uint8Array(16).fill(1)).toString("base64")],
  ["33 bytes", Buffer.from(new Uint8Array(33).fill(1)).toString("base64")],
  [
    "a DER SubjectPublicKeyInfo",
    Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(new Uint8Array(32).fill(1)),
    ]).toString("base64"),
  ],
  ["unpadded", Buffer.from(new Uint8Array(32).fill(1)).toString("base64").replace(/=$/, "")],
];

describe("bootstrap tokens (§4.2): scoped to device-key registration", () => {
  test("the registration response validates and the token carries ≥128 random bits", async () => {
    const { app } = freshApp("bt-shape");
    const a = await register(app, "alice");
    const b = await register(app, "bobby");
    await expectSchema("auth-bootstrap-response.json", a);
    for (const { bootstrap_token: t } of [a, b]) {
      const [, secret = ""] = /^bt_([A-Za-z0-9_-]+)$/.exec(t) ?? [];
      expect(Buffer.from(secret, "base64url").length * 8).toBeGreaterThanOrEqual(128);
    }
    expect(a.bootstrap_token).not.toBe(b.bootstrap_token);
    expect(a.expires_in).toBeLessThanOrEqual(900); // short-lived
  });

  test("sent to any other endpoint it is refused with 401, and stays usable once", async () => {
    const { app } = freshApp("bt-scope");
    const owner = await registerUserWithKey(app, "owner");
    const group = await createGroup(app, owner, { name: "G", tier: "public" });
    const { bootstrap_token: token } = await register(app, "alice");
    const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const attempts: Array<[string, string, unknown?]> = [
      ["GET", "/api/auth/device-keys"],
      ["DELETE", "/api/auth/device-keys/dk_any"],
      ["GET", "/api/me"],
      ["GET", "/api/me/dms"],
      ["POST", "/api/groups", { name: "nope", tier: "public" }],
      ["POST", `/api/groups/${group.id}/join`, {}],
      ["PUT", "/api/me/presence", { status: "online" }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await app.request(path, {
        method,
        headers: bearer,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect([method, path, res.status]).toEqual([method, path, 401]);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
    }

    // None of those consumed it: its one registration still succeeds…
    const { publicKey } = generateKeyPair();
    const reg = await postDeviceKey(app, token, { public_key: publicKey, device_name: "d" });
    expect(reg.status).toBe(201);
    await expectSchema("device-key-response.json", await reg.json());
    // …and only once.
    const again = await postDeviceKey(app, token, {
      public_key: generateKeyPair().publicKey,
      device_name: "d2",
    });
    expect(again.status).toBe(401);
  });
});

describe("device keys (§4.7): list and revoke over HTTP", () => {
  async function addKey(app: App, handle: string, deviceName: string) {
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, password: "correct-horse" }),
    });
    const { bootstrap_token } = (await login.json()) as AuthBootstrapResponse;
    const pair = generateKeyPair();
    const res = await postDeviceKey(app, bootstrap_token, {
      public_key: pair.publicKey,
      algorithm: "Ed25519",
      device_name: deviceName,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key_id: string; created_at: string };
    const signer: Signer = {
      keyId: body.key_id,
      privateKey: pair.privateKey,
      actor: `${handle}@${DOMAIN}`,
    };
    return { signer, publicKey: pair.publicKey, createdAt: body.created_at };
  }

  test("GET lists the caller's own keys with every field, as device-keys-response.json", async () => {
    const { app } = freshApp("dk-list");
    await registerUserWithKey(app, "alice");
    await registerUserWithKey(app, "bobby"); // someone else's key never lists
    const laptop = await addKey(app, "alice", "Laptop");
    const phone = await addKey(app, "alice", "Phone");

    const res = await signedRequest(app, laptop.signer, "GET", "/api/auth/device-keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Array<Record<string, unknown>>;
    };
    await expectSchema("device-keys-response.json", body);
    expect(body.keys).toHaveLength(3); // the registration key + laptop + phone
    for (const k of [laptop, phone]) {
      expect(body.keys).toContainEqual({
        key_id: k.signer.keyId,
        algorithm: "Ed25519",
        public_key: k.publicKey,
        device_name: k.signer.keyId === laptop.signer.keyId ? "Laptop" : "Phone",
        created_at: k.createdAt,
      });
    }
  });

  test("DELETE revokes (204): the key no longer lists or verifies; others are unaffected", async () => {
    const { app } = freshApp("dk-revoke");
    await registerUserWithKey(app, "alice");
    const laptop = await addKey(app, "alice", "Laptop");
    const phone = await addKey(app, "alice", "Phone");

    const del = await signedRequest(
      app,
      laptop.signer,
      "DELETE",
      `/api/auth/device-keys/${phone.signer.keyId}`,
    );
    expect(del.status).toBe(204);

    const list = (await (
      await signedRequest(app, laptop.signer, "GET", "/api/auth/device-keys")
    ).json()) as { keys: Array<{ key_id: string }> };
    expect(list.keys.map((k) => k.key_id)).not.toContain(phone.signer.keyId);
    expect(list.keys.map((k) => k.key_id)).toContain(laptop.signer.keyId);

    expect((await signedRequest(app, phone.signer, "GET", "/api/me")).status).toBe(401);
    expect((await signedRequest(app, laptop.signer, "GET", "/api/me")).status).toBe(200);
    // Revoking it again, or a key that is not the caller's, is a 404.
    const again = await signedRequest(
      app,
      laptop.signer,
      "DELETE",
      `/api/auth/device-keys/${phone.signer.keyId}`,
    );
    expect(again.status).toBe(404);
  });
});

describe("submitted keys must decode to exactly 32 bytes (§4.3.2)", () => {
  for (const [name, publicKey] of BAD_KEYS) {
    test(`device-key registration with a ${name} key → 400, the token unspent`, async () => {
      const { app } = freshApp(`dk-bad-${name.replace(/\W/g, "")}`);
      const { bootstrap_token: token } = await register(app, "alice");
      const res = await postDeviceKey(app, token, { public_key: publicKey, device_name: "d" });
      expect(res.status).toBe(400);
      await expectSchema("problem-details.json", await res.json());
      const ok = await postDeviceKey(app, token, {
        public_key: generateKeyPair().publicKey,
        device_name: "d",
      });
      expect(ok.status).toBe(201);
    });

    test(`guest creation with a ${name} key → 400, no guest provisioned`, async () => {
      const { app } = freshApp(`guest-bad-${name.replace(/\W/g, "")}`);
      const owner = await registerUserWithKey(app, "owner");
      const group = await createGroup(app, owner, {
        name: "G",
        tier: "public",
        joinPolicy: "invite",
      });
      const inv = await signedRequest(app, owner, "POST", `/api/groups/${group.id}/invites`, {
        grantsGuest: true,
        maxUses: 1,
      });
      expect(inv.status).toBe(201);
      const { token } = (await inv.json()) as { token: string };

      const guest = (key: string) =>
        app.request(`/api/invites/${token}/guest`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ public_key: key, algorithm: "Ed25519", device_name: "d" }),
        });
      const res = await guest(publicKey);
      expect(res.status).toBe(400);
      await expectSchema("problem-details.json", await res.json());

      const members = (await (
        await signedRequest(app, owner, "GET", `/api/groups/${group.id}/members`)
      ).json()) as { items: unknown[] };
      expect(members.items).toHaveLength(1); // the owner only
      // The single-use invite was not spent by the refused request.
      expect((await guest(generateKeyPair().publicKey)).status).toBe(201);
    });
  }
});
