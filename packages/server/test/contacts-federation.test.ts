/**
 * Cross-provider contacts (§6.7 "Federation") with real remote key
 * resolution: alice@a.test's client mirrors each state change to bob@b.test's
 * provider with a user-signed `POST /api/federation/contacts`, which B verifies
 * against alice's keys fetched from A (§4.6).
 *
 * Covers the full lifecycle in both directions — request, accept and remove —
 * including `remove` cancelling a request, declining one and ending an
 * accepted contact (which ends the `contacts` tier), and `403` for a `remove`
 * signed by anyone but `from`.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { areContacts } from "../src/provider/contacts.ts";
import { type FedUser, registerOn, signedTo } from "./helpers/federation-users.ts";
import { type Federation, startFederation } from "./helpers/two-provider.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-contacts-fed-"));
});

const open: Federation[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.stop();
  rmSync(tmp, { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "forumall-contacts-fed-"));
});

async function setup() {
  const fed = startFederation(tmp);
  open.push(fed);
  const alice = await registerOn(fed.a, "alice"); // remote to B
  const bob = await registerOn(fed.b, "bob"); // local to B
  return { fed, alice, bob };
}

interface ContactRow {
  user: string;
  state: string;
  direction?: string;
}

async function contactsOf(fed: Federation, user: FedUser): Promise<ContactRow[]> {
  const res = await signedTo(fed.b, user, "GET", "/api/me/contacts");
  expect(res.status).toBe(200);
  return ((await res.json()) as { contacts: ContactRow[] }).contacts;
}

function mirror(fed: Federation, signer: FedUser, action: string, from: string, to: string) {
  return signedTo(fed.b, signer, "POST", "/api/federation/contacts", { action, from, to });
}

describe("federated contact remove (§6.7)", () => {
  test("remove ends an accepted contact on the receiving provider (and the contacts tier)", async () => {
    const { fed, alice, bob } = await setup();
    expect((await mirror(fed, alice, "request", alice.actor, bob.actor)).status).toBe(200);
    const accept = await signedTo(
      fed.b,
      bob,
      "POST",
      `/api/me/contacts/${encodeURIComponent(alice.actor)}/accept`,
    );
    expect(accept.status).toBe(200);
    expect(areContacts(fed.b.db, "bob", alice.actor)).toBe(true);

    const removed = await mirror(fed, alice, "remove", alice.actor, bob.actor);
    expect(removed.status).toBe(204);
    expect(await contactsOf(fed, bob)).toEqual([]);
    expect(areContacts(fed.b.db, "bob", alice.actor)).toBe(false);
  });

  test("remove cancels a request the remote actor sent (bob's incoming pending)", async () => {
    const { fed, alice, bob } = await setup();
    await mirror(fed, alice, "request", alice.actor, bob.actor);
    expect(await contactsOf(fed, bob)).toMatchObject([
      { user: alice.actor, state: "pending", direction: "incoming" },
    ]);
    expect((await mirror(fed, alice, "remove", alice.actor, bob.actor)).status).toBe(204);
    expect(await contactsOf(fed, bob)).toEqual([]);
  });

  test("remove declines a request the local user sent (bob's outgoing pending)", async () => {
    const { fed, alice, bob } = await setup();
    const req = await signedTo(fed.b, bob, "POST", "/api/me/contacts", { user: alice.actor });
    expect(req.status).toBe(201);
    expect((await mirror(fed, alice, "remove", alice.actor, bob.actor)).status).toBe(204);
    expect(await contactsOf(fed, bob)).toEqual([]);
  });

  test("remove with no relationship is a no-op 204", async () => {
    const { fed, alice, bob } = await setup();
    expect((await mirror(fed, alice, "remove", alice.actor, bob.actor)).status).toBe(204);
    expect(await contactsOf(fed, bob)).toEqual([]);
  });

  test("a remove signed by anyone but `from` → 403, nothing changed", async () => {
    const { fed, alice, bob } = await setup();
    const mallory = await registerOn(fed.a, "mallory");
    await mirror(fed, alice, "request", alice.actor, bob.actor);
    const forged = await mirror(fed, mallory, "remove", alice.actor, bob.actor);
    expect(forged.status).toBe(403);
    expect(await contactsOf(fed, bob)).toMatchObject([{ user: alice.actor, state: "pending" }]);
  });

  test("a remove for a `to` that is not local → 404", async () => {
    const { fed, alice } = await setup();
    const res = await mirror(fed, alice, "remove", alice.actor, "ghost@b.test");
    expect(res.status).toBe(404);
  });
});
