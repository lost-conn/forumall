/**
 * P6 privacy + profile/membership + visibility-resolver tests (spec §5.1, §6).
 *
 * Covers:
 *  - {@link canView} unit tests for every §6.1 enum value, allow/deny precedence,
 *    and self-always-visible.
 *  - `GET/PUT /api/me/privacy` round-trips + defaults when unset (§6.6).
 *  - `PATCH /api/me/profile` + `GET /api/users/{ref}/profile` bio gating under
 *    each profileVisibility (§6.2/6.3), with the base profile always returned.
 *  - `GET /api/users/{ref}/groups` membership-visibility filtering (§6.5).
 *  - `GET /api/me` returns the caller's account and never leaks others' fields.
 *
 * REST calls go over an ephemeral-port server with the shared `sign()` helper,
 * mirroring the contacts suite. Argon2id cost is reduced (TEST-ONLY).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthBootstrapResponse, generateKeyPair, sign } from "@forumall/shared";

import { type AppWithWebSocket, createApp } from "../src/app.ts";
import { type Argon2Params, type Config, loadConfig } from "../src/config.ts";
import { type Db, openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { addMember } from "../src/provider/membership.ts";
import { canView } from "../src/provider/visibility.ts";

const FAST_ARGON2: Argon2Params = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const DOMAIN = "providera.test";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-privacy-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Booted {
  app: AppWithWebSocket;
  db: Db;
  config: Config;
  server: ReturnType<typeof Bun.serve>;
}

const booted: Booted[] = [];

function boot(name: string): Booted {
  const base = loadConfig({
    DATA_DIR: tmp,
    DB_PATH: join(tmp, `${name}.sqlite`),
    WEB_DIR: join(tmp, `${name}-web`),
    DOMAIN,
  });
  const config: Config = Object.freeze({ ...base, argon2: FAST_ARGON2 });
  const db = openDb(config.dbPath);
  migrate(db);
  const app = createApp(config, { db });
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: app.__websocket });
  const b: Booted = { app, db, config, server };
  booted.push(b);
  return b;
}

afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

interface Signer {
  keyId: string;
  privateKey: string;
  publicKey: string;
  actor: string;
  handle: string;
}

async function http(b: Booted, path: string, init: RequestInit): Promise<Response> {
  return fetch(`http://${b.server.hostname}:${b.server.port}${path}`, init);
}

async function registerUserWithKey(b: Booted, handle: string): Promise<Signer> {
  const reg = await http(b, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, password: "correct-horse" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as AuthBootstrapResponse).bootstrap_token;

  const { publicKey, privateKey } = generateKeyPair();
  const res = await http(b, "/api/auth/device-keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ public_key: publicKey, algorithm: "Ed25519", device_name: "dev" }),
  });
  expect(res.status).toBe(201);
  const keyId = ((await res.json()) as { key_id: string }).key_id;
  return { keyId, privateKey, publicKey, actor: `${handle}@${DOMAIN}`, handle };
}

async function signedReq(
  b: Booted,
  signer: Signer,
  method: string,
  path: string,
  bodyObj?: unknown,
): Promise<Response> {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
  return http(b, path, {
    method,
    headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
    ...(body !== undefined ? { body } : {}),
  });
}

/** Create a group via the API; the caller becomes owner. Returns the group id. */
async function createOpenGroup(b: Booted, owner: Signer, name: string): Promise<string> {
  const res = await signedReq(b, owner, "POST", "/api/groups", {
    name,
    tier: "public",
    joinPolicy: "open",
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Accept a contact relationship between two local users (mutual accepted). */
async function makeContacts(b: Booted, a: Signer, c: Signer): Promise<void> {
  const req = await signedReq(b, a, "POST", "/api/me/contacts", { user: c.actor });
  expect(req.status).toBe(201);
  const acc = await signedReq(
    b,
    c,
    "POST",
    `/api/me/contacts/${encodeURIComponent(a.actor)}/accept`,
  );
  expect(acc.status).toBe(200);
}

// ---------------------------------------------------------------------------
// canView unit tests (§6.1)
// ---------------------------------------------------------------------------

describe("canView (§6.1)", () => {
  function viewer(handle: string) {
    return { actor: `${handle}@${DOMAIN}`, handle, domain: DOMAIN };
  }

  test("public is visible to anyone, even unauthenticated", () => {
    const b = boot("canview-public");
    expect(
      canView(b.db, {
        subjectHandle: "alice",
        subjectDomain: DOMAIN,
        viewerActor: null,
        policy: "public",
      }),
    ).toBe(true);
  });

  test("authenticated: visible to an authenticated viewer, not anonymous", () => {
    const b = boot("canview-auth");
    const base = {
      subjectHandle: "alice",
      subjectDomain: DOMAIN,
      policy: "authenticated" as const,
    };
    expect(canView(b.db, { ...base, viewerActor: viewer("bob") })).toBe(true);
    expect(canView(b.db, { ...base, viewerActor: null })).toBe(false);
  });

  test("sharedGroups: true only when viewer shares a group with subject", () => {
    const b = boot("canview-shared");
    addMember(b.db, "grp_x", `alice@${DOMAIN}`, "owner");
    addMember(b.db, "grp_x", `bob@${DOMAIN}`, "member");
    // carol shares nothing.
    const base = { subjectHandle: "alice", subjectDomain: DOMAIN, policy: "sharedGroups" as const };
    expect(canView(b.db, { ...base, viewerActor: viewer("bob") })).toBe(true);
    expect(canView(b.db, { ...base, viewerActor: viewer("carol") })).toBe(false);
    expect(canView(b.db, { ...base, viewerActor: null })).toBe(false);
  });

  test("contacts: true only for an accepted contact of the subject", async () => {
    const b = boot("canview-contacts");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    await registerUserWithKey(b, "carol");
    await makeContacts(b, alice, bob); // alice holds accepted row for bob
    const base = { subjectHandle: "alice", subjectDomain: DOMAIN, policy: "contacts" as const };
    expect(canView(b.db, { ...base, viewerActor: viewer("bob") })).toBe(true);
    expect(canView(b.db, { ...base, viewerActor: viewer("carol") })).toBe(false);
  });

  test("nobody: hidden from everyone except self", () => {
    const b = boot("canview-nobody");
    const base = { subjectHandle: "alice", subjectDomain: DOMAIN, policy: "nobody" as const };
    expect(canView(b.db, { ...base, viewerActor: viewer("bob") })).toBe(false);
    // self is always visible, even under nobody.
    expect(canView(b.db, { ...base, viewerActor: viewer("alice") })).toBe(true);
  });

  test("self is always visible regardless of policy", () => {
    const b = boot("canview-self");
    for (const policy of [
      "public",
      "authenticated",
      "sharedGroups",
      "contacts",
      "nobody",
    ] as const) {
      expect(
        canView(b.db, {
          subjectHandle: "alice",
          subjectDomain: DOMAIN,
          viewerActor: viewer("alice"),
          policy,
        }),
      ).toBe(true);
    }
  });

  test("precedence: deny wins over allow and over policy", () => {
    const b = boot("canview-deny");
    // policy public would allow, but deny overrides.
    expect(
      canView(b.db, {
        subjectHandle: "alice",
        subjectDomain: DOMAIN,
        viewerActor: viewer("bob"),
        policy: "public",
        allowList: [`bob@${DOMAIN}`],
        denyList: [`bob@${DOMAIN}`],
      }),
    ).toBe(false);
  });

  test("precedence: allow overrides a restrictive policy", () => {
    const b = boot("canview-allow");
    // policy nobody would hide, but allow overrides (and bob isn't self).
    expect(
      canView(b.db, {
        subjectHandle: "alice",
        subjectDomain: DOMAIN,
        viewerActor: viewer("bob"),
        policy: "nobody",
        allowList: [`bob@${DOMAIN}`],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET/PUT /api/me/privacy (§6.6)
// ---------------------------------------------------------------------------

describe("privacy settings (§6.6)", () => {
  test("defaults returned when unset", async () => {
    const b = boot("privacy-defaults");
    const alice = await registerUserWithKey(b, "alice");
    const res = await signedReq(b, alice, "GET", "/api/me/privacy");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.presenceVisibility).toBe("sharedGroups");
    expect(body.profileVisibility).toBe("public");
    expect(body.membershipVisibility).toBe("authenticated");
  });

  test("PUT then GET round-trips", async () => {
    const b = boot("privacy-roundtrip");
    const alice = await registerUserWithKey(b, "alice");
    const put = await signedReq(b, alice, "PUT", "/api/me/privacy", {
      presenceVisibility: "contacts",
      profileVisibility: "nobody",
      membershipVisibility: "sharedGroups",
      allowList: [`bob@${DOMAIN}`],
      denyList: [`carol@${DOMAIN}`],
      metadata: [],
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as Record<string, unknown>;
    expect(putBody.profileVisibility).toBe("nobody");
    expect(putBody.allowList).toEqual([`bob@${DOMAIN}`]);

    const get = await signedReq(b, alice, "GET", "/api/me/privacy");
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.presenceVisibility).toBe("contacts");
    expect(body.profileVisibility).toBe("nobody");
    expect(body.membershipVisibility).toBe("sharedGroups");
    expect(body.denyList).toEqual([`carol@${DOMAIN}`]);
  });

  test("partial PUT leaves other fields unchanged", async () => {
    const b = boot("privacy-partial");
    const alice = await registerUserWithKey(b, "alice");
    await signedReq(b, alice, "PUT", "/api/me/privacy", { profileVisibility: "contacts" });
    const get = await signedReq(b, alice, "GET", "/api/me/privacy");
    const body = (await get.json()) as Record<string, string>;
    expect(body.profileVisibility).toBe("contacts");
    // defaults preserved for the untouched fields.
    expect(body.presenceVisibility).toBe("sharedGroups");
    expect(body.membershipVisibility).toBe("authenticated");
  });
});

// ---------------------------------------------------------------------------
// Profile bio gating (§6.2/6.3)
// ---------------------------------------------------------------------------

describe("profile + bio gating (§6.2/6.3)", () => {
  test("PATCH then GET: bio visible under public, base profile always returned", async () => {
    const b = boot("profile-public");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");

    const patch = await signedReq(b, alice, "PATCH", "/api/me/profile", {
      displayName: "Alice A",
      bio: "Hello!",
    });
    expect(patch.status).toBe(200);

    // default profileVisibility is public → bob sees bio + base profile.
    const res = await signedReq(b, bob, "GET", "/api/users/alice/profile");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.handle).toBe("alice");
    expect(body.displayName).toBe("Alice A");
    expect(body.bio).toBe("Hello!");
  });

  test("avatar must be an https URI: empty string → 400, omitted → 200, valid → 200", async () => {
    const b = boot("profile-avatar");
    const alice = await registerUserWithKey(b, "alice");

    // An empty-string avatar fails the https URI constraint (the reported bug:
    // the client must omit a blank avatar rather than send "").
    const blank = await signedReq(b, alice, "PATCH", "/api/me/profile", {
      displayName: "Alice",
      avatar: "",
    });
    expect(blank.status).toBe(400);

    // Omitting avatar entirely succeeds (text fields still update).
    const omitted = await signedReq(b, alice, "PATCH", "/api/me/profile", {
      displayName: "Alice",
      bio: "hi",
    });
    expect(omitted.status).toBe(200);

    // A valid https avatar is accepted and surfaced.
    const valid = await signedReq(b, alice, "PATCH", "/api/me/profile", {
      avatar: "https://cdn.example/a.png",
    });
    expect(valid.status).toBe(200);
    expect(((await valid.json()) as Record<string, unknown>).avatar).toBe(
      "https://cdn.example/a.png",
    );
  });

  test("bio hidden under nobody, base profile still returned", async () => {
    const b = boot("profile-nobody");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");

    await signedReq(b, alice, "PATCH", "/api/me/profile", { displayName: "Alice", bio: "secret" });
    await signedReq(b, alice, "PUT", "/api/me/privacy", { profileVisibility: "nobody" });

    const res = await signedReq(b, bob, "GET", "/api/users/alice/profile");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.handle).toBe("alice"); // base profile present
    expect(body.displayName).toBe("Alice");
    expect(body.bio).toBeUndefined(); // extra hidden

    // self still sees own bio.
    const own = await signedReq(b, alice, "GET", "/api/users/alice/profile");
    expect(((await own.json()) as Record<string, unknown>).bio).toBe("secret");
  });

  test("bio under contacts: visible to an accepted contact, hidden otherwise", async () => {
    const b = boot("profile-contacts");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");

    await signedReq(b, alice, "PATCH", "/api/me/profile", { bio: "for friends" });
    await signedReq(b, alice, "PUT", "/api/me/privacy", { profileVisibility: "contacts" });
    await makeContacts(b, alice, bob);

    const bobRes = await signedReq(b, bob, "GET", "/api/users/alice/profile");
    expect(((await bobRes.json()) as Record<string, unknown>).bio).toBe("for friends");

    const carolRes = await signedReq(b, carol, "GET", "/api/users/alice/profile");
    expect(((await carolRes.json()) as Record<string, unknown>).bio).toBeUndefined();
  });

  test("GET profile for an unknown user → 404", async () => {
    const b = boot("profile-404");
    const alice = await registerUserWithKey(b, "alice");
    const res = await signedReq(b, alice, "GET", "/api/users/ghost/profile");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Membership visibility (§6.5)
// ---------------------------------------------------------------------------

describe("membership listing (§6.5)", () => {
  test("sharedGroups: sharer sees groups, non-sharer sees empty", async () => {
    const b = boot("groups-shared");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");

    const gid = await createOpenGroup(b, alice, "Guild");
    // bob joins → shares the group with alice.
    const join = await signedReq(b, bob, "POST", `/api/groups/${gid}/join`);
    expect(join.status === 200 || join.status === 201).toBe(true);

    await signedReq(b, alice, "PUT", "/api/me/privacy", { membershipVisibility: "sharedGroups" });

    const bobRes = await signedReq(b, bob, "GET", "/api/users/alice/groups");
    expect(bobRes.status).toBe(200);
    const bobBody = (await bobRes.json()) as { groups: { id: string }[] };
    expect(bobBody.groups.length).toBe(1);
    expect(bobBody.groups[0]?.id).toContain(`/api/groups/${gid}`);

    // carol shares no group → empty list (not 403).
    const carolRes = await signedReq(b, carol, "GET", "/api/users/alice/groups");
    expect(carolRes.status).toBe(200);
    expect(((await carolRes.json()) as { groups: unknown[] }).groups.length).toBe(0);
  });

  test("nobody: hidden from everyone but self", async () => {
    const b = boot("groups-nobody");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const gid = await createOpenGroup(b, alice, "Guild");
    await signedReq(b, bob, "POST", `/api/groups/${gid}/join`);
    await signedReq(b, alice, "PUT", "/api/me/privacy", { membershipVisibility: "nobody" });

    // bob (even sharing the group) sees empty.
    const bobRes = await signedReq(b, bob, "GET", "/api/users/alice/groups");
    expect(((await bobRes.json()) as { groups: unknown[] }).groups.length).toBe(0);

    // alice sees her own groups.
    const ownRes = await signedReq(b, alice, "GET", "/api/users/alice/groups");
    expect(((await ownRes.json()) as { groups: unknown[] }).groups.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/me (§5.1.2)
// ---------------------------------------------------------------------------

describe("GET /api/me (§5.1.2)", () => {
  test("returns the caller's account; never another user's private fields", async () => {
    const b = boot("me-account");
    const alice = await registerUserWithKey(b, "alice");
    await registerUserWithKey(b, "bob");

    await signedReq(b, alice, "PATCH", "/api/me/profile", { displayName: "Alice", bio: "mine" });

    const res = await signedReq(b, alice, "GET", "/api/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profile: Record<string, unknown>;
      settings: Record<string, unknown>;
    };
    expect(body.profile.handle).toBe("alice");
    expect(body.profile.displayName).toBe("Alice");
    expect(body.settings).toBeDefined();
    // The private account NEVER carries password/recovery fields.
    const flat = JSON.stringify(body);
    expect(flat).not.toContain("passwordHash");
    expect(flat).not.toContain("password_hash");
    expect(flat).not.toContain("recoveryEmail");
    expect(flat).not.toContain("recovery_email");
    // GET /api/me reflects the caller only — never includes bob's handle.
    expect(flat).not.toContain("bob");
  });
});
