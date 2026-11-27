/**
 * `GET /api/users/{userRef}/{profile,presence,groups}` for anonymous and signed
 * viewers (OFSCP §4.5 "Anonymous viewers", §6.1–§6.5).
 *
 *  - An unsigned request is an anonymous viewer: it satisfies only the `public`
 *    visibility, never matches a privacy list, and is never `401`.
 *  - `…/groups` lists only hosted groups the viewer may read under the group's
 *    tier (§6.5, §11.3 condition 1): anonymous → public/discoverable only.
 *  - Every non-hosted, unknown or invalid subject gets the same `404` body on
 *    all three routes, and the `{userRef}` segment is decoded exactly once
 *    (§2.2), so `%25` / `%2540` are that `404`, not a `500` or a second decode.
 *
 * Real `Bun.serve` + WS via the shared provider harness; no mocks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Booted,
  DOMAIN,
  type Signer,
  addMember,
  boot,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
} from "./helpers/provider-harness.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-users-anon-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const booted: Booted[] = [];
let seq = 0;
function start(): Booted {
  const b = boot(tmp, `users-anon-${seq++}`);
  booted.push(b);
  return b;
}
afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

function anon(b: Booted, path: string): Promise<Response> {
  return fetch(`http://${b.server.hostname}:${b.server.port}${path}`);
}

async function setPrivacy(b: Booted, who: Signer, body: Record<string, unknown>): Promise<void> {
  const res = await signedReq(b, who, "PUT", "/api/me/privacy", body);
  expect(res.status).toBe(200);
}

async function createGroup(b: Booted, owner: Signer, tier: string): Promise<string> {
  const res = await signedReq(b, owner, "POST", "/api/groups", { name: `g-${tier}`, tier });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const groupUri = (id: string) => `https://${DOMAIN}/api/groups/${id}`;

async function groupsSeen(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { groups: { id: string }[] };
  return body.groups.map((g) => g.id).sort();
}

describe("anonymous viewers on the §6 GET routes (§4.5, §6.1)", () => {
  test("profile: the base profile always, `bio` only under `public`", async () => {
    const b = start();
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const patch = await signedReq(b, alice, "PATCH", "/api/me/profile", { bio: "hello" });
    expect(patch.status).toBe(200);

    await setPrivacy(b, alice, { profileVisibility: "public" });
    const pub = await anon(b, "/api/users/alice/profile");
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as { handle: string; bio?: string };
    expect(pubBody.handle).toBe("alice");
    expect(pubBody.bio).toBe("hello");

    await setPrivacy(b, alice, { profileVisibility: "authenticated" });
    const hidden = await anon(b, "/api/users/alice/profile");
    expect(hidden.status).toBe(200);
    const hiddenBody = (await hidden.json()) as { handle: string; bio?: string };
    expect(hiddenBody.handle).toBe("alice");
    expect(hiddenBody.bio).toBeUndefined();
    // A signed viewer does satisfy `authenticated`.
    const signed = await signedReq(b, bob, "GET", "/api/users/alice/profile");
    expect(((await signed.json()) as { bio?: string }).bio).toBe("hello");

    // An anonymous viewer never matches the allow list.
    await setPrivacy(b, alice, { profileVisibility: "nobody", allowList: [bob.actor] });
    expect(
      ((await (await anon(b, "/api/users/alice/profile")).json()) as { bio?: string }).bio,
    ).toBeUndefined();
  });

  test("presence: real presence under `public`, uniform offline otherwise", async () => {
    const b = start();
    const alice = await registerUserWithKey(b, "alice");
    const ws = await connectAuthenticated(b, alice);
    try {
      await setPrivacy(b, alice, { presenceVisibility: "public" });
      const pub = await anon(b, "/api/users/alice/presence");
      expect(pub.status).toBe(200);
      expect(((await pub.json()) as { availability: string }).availability).toBe("online");

      await setPrivacy(b, alice, { presenceVisibility: "authenticated" });
      const hidden = await anon(b, "/api/users/alice/presence");
      expect(hidden.status).toBe(200);
      expect(await hidden.json()).toEqual({ availability: "offline", metadata: [] });
    } finally {
      ws.close();
    }
  });

  test("groups: only hosted groups the viewer may read under the group tier", async () => {
    const b = start();
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const carol = await registerUserWithKey(b, "carol");
    const pub = await createGroup(b, alice, "public");
    const disc = await createGroup(b, alice, "discoverable");
    const priv = await createGroup(b, alice, "private");
    const grp = await createGroup(b, alice, "group");
    addMember(b, priv, carol, "member");
    await setPrivacy(b, alice, { membershipVisibility: "public" });

    const readable = [groupUri(pub), groupUri(disc)].sort();
    // Anonymous: public/discoverable only.
    expect(await groupsSeen(await anon(b, "/api/users/alice/groups"))).toEqual(readable);
    // A signed non-member: likewise.
    expect(await groupsSeen(await signedReq(b, bob, "GET", "/api/users/alice/groups"))).toEqual(
      readable,
    );
    // A fellow member of the private group also sees that one (not `grp`).
    expect(await groupsSeen(await signedReq(b, carol, "GET", "/api/users/alice/groups"))).toEqual(
      [...readable, groupUri(priv)].sort(),
    );
    // The subject sees all of her groups.
    expect(await groupsSeen(await signedReq(b, alice, "GET", "/api/users/alice/groups"))).toEqual(
      [groupUri(pub), groupUri(disc), groupUri(priv), groupUri(grp)].sort(),
    );

    // Not permitted by membershipVisibility → the uniform empty listing.
    await setPrivacy(b, alice, { membershipVisibility: "authenticated" });
    const hidden = await anon(b, "/api/users/alice/groups");
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toEqual({ groups: [], metadata: [] });
  });
});

describe("subjects these routes do not serve → one uniform 404 (§6.1, §2.2)", () => {
  const ROUTES = ["profile", "presence", "groups"] as const;
  const NOT_SERVED = [
    "nobody", // unknown handle
    "nobody%40providera.test", // unknown actor
    "alice%40other.test", // a user on another provider
    encodeURIComponent("https://other.test/api/users/alice"), // foreign user URI
    encodeURIComponent(`https://${DOMAIN}/api/groups/g`), // not a user URI
    "a%25", // decodes to `a%`: a second decode would throw (500)
    "alice%2540providera.test", // `alice%40providera.test` once decoded, never `alice@…`
    "Alice", // not a valid handle
    "a%20b", // whitespace
  ];

  test("every route, signed or not, answers the same 404 body", async () => {
    const b = start();
    const alice = await registerUserWithKey(b, "alice");
    const bodies = new Set<string>();
    for (const route of ROUTES) {
      for (const ref of NOT_SERVED) {
        const path = `/api/users/${ref}/${route}`;
        for (const res of [await anon(b, path), await signedReq(b, alice, "GET", path)]) {
          expect({ path, status: res.status }).toEqual({ path, status: 404 });
          bodies.add(await res.text());
        }
      }
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0] as string)).toMatchObject({ errorCode: "not_found" });
  });

  test("the local user is found by handle, actor and user URI (decoded once)", async () => {
    const b = start();
    await registerUserWithKey(b, "alice");
    for (const ref of [
      "alice",
      "alice%40providera.test",
      encodeURIComponent(`https://${DOMAIN}/api/users/alice`),
    ]) {
      for (const route of ROUTES) {
        const res = await anon(b, `/api/users/${ref}/${route}`);
        expect({ ref, route, status: res.status }).toEqual({ ref, route, status: 200 });
      }
    }
  });
});
