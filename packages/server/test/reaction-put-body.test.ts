/**
 * The optional body of `PUT …/reactions/{key}` (OFSCP §7.1,
 * `reaction-put-request.json`, lost-conn/ofscp#30), on every route that takes
 * it: the group route, the DM route (§7.4) and the federation DM route (§8.3).
 *
 * The body may be absent or empty (not checked), and `{}` is valid. `unicode`
 * and `image` (an `https` URL) are each optional and independent of each other
 * and of `key`; both are stored and served on the `Reaction`. Anything that
 * does not match — malformed JSON, a non-object, a non-string `unicode`, a
 * non-`https` `image` — is `400 bad_request`, and nothing is stored.
 *
 * Argon2id cost is reduced (TEST-ONLY, in the harnesses) so register stays fast.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Reaction, deriveDmId, signProvider } from "@forumall/shared";

import { getProviderSigningKey } from "../src/provider/signing-key.ts";
import { registerAt, signedReqAt } from "./helpers/cross-provider.ts";
import {
  type Booted,
  type Signer,
  boot,
  makeGroupChannel,
  registerUserWithKey,
  signedReq,
} from "./helpers/provider-harness.ts";
import { type Federation, startFederation } from "./helpers/two-provider.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-reaction-body-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const booted: Booted[] = [];
const feds: Federation[] = [];
afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
  for (const f of feds.splice(0)) f.stop();
});

function bootOne(name: string): Booted {
  const b = boot(tmp, name);
  booted.push(b);
  return b;
}

const IMAGE = "https://cdn.example/heart.png";

/** A body to send: a JSON value, or `raw` bytes sent as-is, or nothing. */
type Body = { json: unknown } | { raw: string } | { none: true };

/** Bodies the schema accepts, each with the `unicode`/`image` it should store. */
const ACCEPTED: { name: string; body: Body; unicode?: string; image?: string }[] = [
  { name: "absent", body: { none: true } },
  { name: "empty", body: { raw: "" } },
  { name: "whitespace", body: { raw: "  \n" } },
  { name: "{}", body: { json: {} } },
  { name: "unicode only", body: { json: { unicode: "❤️" } }, unicode: "❤️" },
  { name: "image only", body: { json: { image: IMAGE } }, image: IMAGE },
  {
    name: "unicode + image",
    body: { json: { unicode: "🎉", image: IMAGE } },
    unicode: "🎉",
    image: IMAGE,
  },
  { name: "unknown field (§2.3)", body: { json: { future: { x: 1 } } } },
];

/** Bodies that do not match the schema → 400. */
const REJECTED: { name: string; body: Body }[] = [
  { name: "http image", body: { json: { image: "http://cdn.example/heart.png" } } },
  { name: "relative image", body: { json: { image: "/heart.png" } } },
  { name: "non-string unicode", body: { json: { unicode: 5 } } },
  { name: "array", body: { json: [] } },
  { name: "string", body: { json: "heart" } },
  { name: "null", body: { json: null } },
  { name: "malformed JSON", body: { raw: "{not json" } },
];

function put(b: Booted, signer: Signer, path: string, body: Body): Promise<Response> {
  if ("none" in body) return signedReq(b, signer, "PUT", path);
  if ("raw" in body) return signedReq(b, signer, "PUT", path, undefined, body.raw);
  return signedReq(b, signer, "PUT", path, undefined, JSON.stringify(body.json));
}

async function expectBadRequest(res: Response, what: string): Promise<void> {
  const problem = (await res.json()) as { errorCode?: string };
  expect({ what, status: res.status, errorCode: problem.errorCode }).toEqual({
    what,
    status: 400,
    errorCode: "bad_request",
  });
}

/** Assert a 2xx `Reaction` carrying exactly the expected `unicode`/`image`. */
async function expectReaction(
  res: Response,
  what: string,
  want: { key: string; author: string; unicode?: string; image?: string },
): Promise<Reaction> {
  expect({ what, ok: res.status === 200 || res.status === 201 }).toEqual({ what, ok: true });
  const r = (await res.json()) as Reaction;
  expect({ what, key: r.key, author: r.author, unicode: r.unicode, image: r.image }).toEqual({
    what,
    key: want.key,
    author: want.author,
    unicode: want.unicode,
    image: want.image,
  });
  return r;
}

/** A key per case, so every accepted body creates a fresh reaction. */
function keyFor(i: number): string {
  return `k${i}`;
}

// ---------------------------------------------------------------------------
// Group route (§7.1)
// ---------------------------------------------------------------------------

describe("PUT /api/groups/{g}/channels/{c}/messages/{m}/reactions/{key} body", () => {
  test("absent, empty, {} and partial bodies are accepted; unicode/image are stored", async () => {
    const b = bootOne("group-accept");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const msgRes = await signedReq(
      b,
      alice,
      "POST",
      `/api/groups/${groupId}/channels/${channelId}/messages`,
      {
        content: { mime: "text/plain", text: "hi" },
      },
    );
    expect(msgRes.status).toBe(201);
    const messageId = ((await msgRes.json()) as { id: string }).id;
    const base = `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/reactions`;

    for (const [i, c] of ACCEPTED.entries()) {
      const want = { key: keyFor(i), author: alice.actor, unicode: c.unicode, image: c.image };
      await expectReaction(await put(b, alice, `${base}/${keyFor(i)}`, c.body), c.name, want);
    }

    // The listing serves what was stored.
    const list = await signedReq(b, alice, "GET", base);
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: Reaction[] }).items;
    expect(items.length).toBe(ACCEPTED.length);
    const both = items.find(
      (r) => r.key === keyFor(ACCEPTED.findIndex((c) => c.unicode && c.image)),
    );
    expect({ unicode: both?.unicode, image: both?.image }).toEqual({ unicode: "🎉", image: IMAGE });
  });

  test("a body that does not match the schema is 400 bad_request and stores nothing", async () => {
    const b = bootOne("group-reject");
    const alice = await registerUserWithKey(b, "alice");
    const { groupId, channelId } = await makeGroupChannel(b, alice);
    const msgRes = await signedReq(
      b,
      alice,
      "POST",
      `/api/groups/${groupId}/channels/${channelId}/messages`,
      {
        content: { mime: "text/plain", text: "hi" },
      },
    );
    const messageId = ((await msgRes.json()) as { id: string }).id;
    const base = `/api/groups/${groupId}/channels/${channelId}/messages/${messageId}/reactions`;

    for (const c of REJECTED) {
      await expectBadRequest(await put(b, alice, `${base}/heart`, c.body), c.name);
    }
    const list = await signedReq(b, alice, "GET", base);
    expect(((await list.json()) as { items: Reaction[] }).items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DM route (§7.4) and the federation DM route called user-signed (§8.3)
// ---------------------------------------------------------------------------

/** alice and bob on one provider; bob sends alice a DM (stored in alice's inbox). */
async function dmSetup(name: string) {
  const b = bootOne(name);
  const alice = await registerUserWithKey(b, "alice");
  const bob = await registerUserWithKey(b, "bob");
  const dmId = deriveDmId(alice.actor, bob.actor);
  const sent = await signedReq(b, bob, "POST", `/api/federation/dms/${dmId}/messages`, {
    clientMessageId: "c1",
    content: { mime: "text/plain", text: "hi alice" },
  });
  expect(sent.status).toBe(201);
  const messageId = ((await sent.json()) as { id: string }).id;
  return { b, alice, bob, dmId, messageId };
}

/** The reactions embedded on `messageId` in `viewer`'s DM history. */
async function dmHistoryReactions(
  b: Booted,
  viewer: Signer,
  dmId: string,
  messageId: string,
): Promise<Reaction[]> {
  const res = await signedReq(b, viewer, "GET", `/api/dms/${dmId}/messages`);
  expect(res.status).toBe(200);
  const items = ((await res.json()) as { items: { id: string; reactions?: Reaction[] }[] }).items;
  return items.find((m) => m.id === messageId)?.reactions ?? [];
}

describe("PUT /api/dms/{dmId}/messages/{m}/reactions/{key} body", () => {
  test("the recipient (own inbox) and the sender (counterparty's inbox) both store unicode/image", async () => {
    const { b, alice, bob, dmId, messageId } = await dmSetup("dm-accept");
    const base = `/api/dms/${dmId}/messages/${messageId}/reactions`;

    for (const [i, c] of ACCEPTED.entries()) {
      const want = { key: keyFor(i), author: alice.actor, unicode: c.unicode, image: c.image };
      await expectReaction(
        await put(b, alice, `${base}/${keyFor(i)}`, c.body),
        `alice ${c.name}`,
        want,
      );
    }
    // bob SENT the message: his reaction lands in alice's inbox (case b).
    const bobRes = await put(b, bob, `${base}/bob`, { json: { unicode: "👍", image: IMAGE } });
    await expectReaction(bobRes, "bob", {
      key: "bob",
      author: bob.actor,
      unicode: "👍",
      image: IMAGE,
    });

    const stored = await dmHistoryReactions(b, alice, dmId, messageId);
    expect(stored.length).toBe(ACCEPTED.length + 1);
    const fromBob = stored.find((r) => r.author === bob.actor);
    expect({ unicode: fromBob?.unicode, image: fromBob?.image }).toEqual({
      unicode: "👍",
      image: IMAGE,
    });
  });

  test("a body that does not match the schema is 400 bad_request and stores nothing", async () => {
    const { b, alice, bob, dmId, messageId } = await dmSetup("dm-reject");
    const base = `/api/dms/${dmId}/messages/${messageId}/reactions/heart`;
    for (const c of REJECTED) {
      await expectBadRequest(await put(b, alice, base, c.body), `alice ${c.name}`);
      await expectBadRequest(await put(b, bob, base, c.body), `bob ${c.name}`);
    }
    expect(await dmHistoryReactions(b, alice, dmId, messageId)).toEqual([]);
  });
});

describe("PUT /api/federation/dms/{dmId}/messages/{m}/reactions/{key} body (user-signed)", () => {
  test("accepts the optional body and stores unicode/image; rejects a mismatch with 400", async () => {
    const { b, alice, bob, dmId, messageId } = await dmSetup("fed-user-signed");
    const base = `/api/federation/dms/${dmId}/messages/${messageId}/reactions`;

    for (const [i, c] of ACCEPTED.entries()) {
      const want = { key: keyFor(i), author: bob.actor, unicode: c.unicode, image: c.image };
      await expectReaction(await put(b, bob, `${base}/${keyFor(i)}`, c.body), c.name, want);
    }
    for (const c of REJECTED) {
      await expectBadRequest(await put(b, bob, `${base}/rejected`, c.body), c.name);
    }
    const stored = await dmHistoryReactions(b, alice, dmId, messageId);
    expect(stored.length).toBe(ACCEPTED.length);
    expect(stored.some((r) => r.key === "rejected")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-provider: forwarded body + provider-signed federation ingest (§8.3)
// ---------------------------------------------------------------------------

describe("DM reaction body across providers", () => {
  async function crossSetup(suffix: string) {
    const fed = startFederation(tmp, {
      domainA: "a.test",
      domainB: "b.test",
      envA: { FEDERATION_INSECURE_LOCALHOST: "1" },
      envB: { FEDERATION_INSECURE_LOCALHOST: "1" },
    });
    feds.push(fed);
    const alice = await registerAt(fed.a.base, "a.test", `alice${suffix}`);
    const bob = await registerAt(fed.b.base, "b.test", `bob${suffix}`);
    const dmId = deriveDmId(alice.actor, bob.actor);
    // alice@a sends to bob@b: the message lives only in bob's inbox on b.
    const sent = await signedReqAt(
      fed.b.base,
      "b.test",
      alice,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      {
        clientMessageId: `s${suffix}`,
        content: { mime: "text/plain", text: "hi bob" },
      },
    );
    expect(sent.status).toBe(201);
    const messageId = ((await sent.json()) as { id: string }).id;
    return { fed, alice, bob, dmId, messageId };
  }

  test("a reaction alice@a makes through her home provider is forwarded to b with its unicode/image", async () => {
    const { fed, alice, bob, dmId, messageId } = await crossSetup("fw");
    // bob replies so a holds alice's conversation row (and so forwards to b).
    const reply = await signedReqAt(
      fed.a.base,
      "a.test",
      bob,
      "POST",
      `/api/federation/dms/${dmId}/messages`,
      {
        clientMessageId: "rfw",
        content: { mime: "text/plain", text: "hey" },
      },
    );
    expect(reply.status).toBe(201);

    const path = `/api/dms/${dmId}/messages/${messageId}/reactions/heart`;
    const bad = await signedReqAt(fed.a.base, "a.test", alice, "PUT", path, {
      image: "http://x.example/h.png",
    });
    await expectBadRequest(bad, "forwarded http image");

    const res = await signedReqAt(fed.a.base, "a.test", alice, "PUT", path, {
      unicode: "❤️",
      image: IMAGE,
    });
    await expectReaction(res, "forwarded", {
      key: "heart",
      author: alice.actor,
      unicode: "❤️",
      image: IMAGE,
    });

    const hist = await signedReqAt(fed.b.base, "b.test", bob, "GET", `/api/dms/${dmId}/messages`);
    const items = ((await hist.json()) as { items: { id: string; reactions?: Reaction[] }[] })
      .items;
    const stored = items.find((m) => m.id === messageId)?.reactions ?? [];
    expect(stored.map((r) => ({ author: r.author, unicode: r.unicode, image: r.image }))).toEqual([
      { author: alice.actor, unicode: "❤️", image: IMAGE },
    ]);
  });

  test("the provider-signed federation ingest takes the body beside `actor`; a mismatch is 400", async () => {
    const { fed, alice, bob, dmId, messageId } = await crossSetup("ps");
    const keyA = getProviderSigningKey(fed.a.db);
    const path = `/api/federation/dms/${dmId}/messages/${messageId}/reactions`;
    const providerPut = (key: string, bodyObj: unknown) => {
      const body = JSON.stringify(bodyObj);
      const { headers } = signProvider({
        provider: "a.test",
        keyId: keyA.keyId,
        privateKey: keyA.privateKey,
        authority: "b.test",
        method: "PUT",
        path: `${path}/${key}`,
        body,
      });
      return fetch(`${fed.b.base}${path}/${key}`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body,
      });
    };

    await expectBadRequest(
      await providerPut("bad", { actor: alice.actor, image: "http://x.example/h.png" }),
      "provider-signed http image",
    );
    await expectBadRequest(
      await providerPut("bad", { actor: alice.actor, unicode: 7 }),
      "provider-signed non-string unicode",
    );
    await expectReaction(await providerPut("bare", { actor: alice.actor }), "actor only", {
      key: "bare",
      author: alice.actor,
    });
    await expectReaction(
      await providerPut("full", { actor: alice.actor, unicode: "🎉", image: IMAGE }),
      "actor + unicode + image",
      { key: "full", author: alice.actor, unicode: "🎉", image: IMAGE },
    );

    const hist = await signedReqAt(fed.b.base, "b.test", bob, "GET", `/api/dms/${dmId}/messages`);
    const items = ((await hist.json()) as { items: { id: string; reactions?: Reaction[] }[] })
      .items;
    const keys = (items.find((m) => m.id === messageId)?.reactions ?? []).map((r) => r.key).sort();
    expect(keys).toEqual(["bare", "full"]);
  });
});
