/**
 * Read-marker wire conformance (§7.7): live `GET`/`PATCH /api/me/read-markers`
 * bodies and the `read.updated` frame, validated against the spec's OWN JSON
 * Schemas from the sibling `ofscp` repo (`read-markers-update-request.json`,
 * `read-markers-response.json`, `ws/read-updated.json`) via ajv — not against
 * our zod mirror. The request body sent is validated too, so the suite proves
 * the server accepts exactly what the schema describes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveDmId } from "@forumall/shared";

import { makeOfscpCompiler } from "./helpers/ofscp-schemas.ts";
import {
  type Booted,
  boot,
  connectAuthenticated,
  registerUserWithKey,
} from "./helpers/provider-harness.ts";
import {
  dmTo,
  getMarkers,
  patchMarkers,
  post,
  seedGroupChannel,
} from "./helpers/read-markers-fixtures.ts";

const compile = makeOfscpCompiler();

/** Validate `body` against `schemaFile`, failing with ajv's errors. */
async function expectValid(schemaFile: string, body: unknown): Promise<void> {
  const validate = await compile(schemaFile);
  const ok = validate(body);
  if (!ok) throw new Error(`${schemaFile}: ${JSON.stringify(validate.errors, null, 2)}`);
  expect(ok).toBe(true);
}

let tmp: string;
const booted: Booted[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-readmarkers-conf-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

describe("read markers vs the OFSCP v0.1 schemas", () => {
  test("PATCH request, PATCH/GET responses and read.updated validate", async () => {
    const b = boot(tmp, "rm-conformance");
    booted.push(b);
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = seedGroupChannel(b, alice, [bob]);
    const m1 = post(b, groupId, channelId, bob, "a");
    post(b, groupId, channelId, bob, "b");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const dm = dmTo(b, dmId, alice, bob, "dm");

    // GET before anything is read: entries without `lastReadMessageId`.
    const before = await getMarkers(b, alice);
    expect(before.length).toBe(2);
    await expectValid("read-markers-response.json", { scopes: before });

    const device2 = await connectAuthenticated(b, alice);
    const request = {
      markers: [
        { scopeId: channelId, lastReadMessageId: m1.id },
        { scopeId: dmId, lastReadMessageId: dm.id },
      ],
    };
    await expectValid("read-markers-update-request.json", request);
    const res = await patchMarkers(b, alice, request);
    expect(res.status).toBe(200);
    const patched = await res.json();
    await expectValid("read-markers-response.json", patched);
    expect((patched as { scopes: unknown[] }).scopes.length).toBe(2);

    const evt = await device2.ofType("read.updated");
    await expectValid("ws/read-updated.json", evt);
    device2.close();

    // GET after: entries with `lastReadMessageId`.
    const after = await getMarkers(b, alice);
    expect(after.every((s) => typeof s.lastReadMessageId === "string")).toBe(true);
    await expectValid("read-markers-response.json", { scopes: after });

    // An advance-nothing PATCH still answers a valid (empty) response.
    const none = await patchMarkers(b, alice, request);
    await expectValid("read-markers-response.json", await none.json());
  });

  test("the old seq body is not a valid request, and the server refuses it", async () => {
    const b = boot(tmp, "rm-conformance-old");
    booted.push(b);
    const alice = await registerUserWithKey(b, "alice");
    const { channelId } = seedGroupChannel(b, alice);
    const old = { scopeId: channelId, lastReadSeq: 1 };
    const validate = await compile("read-markers-update-request.json");
    expect(validate(old)).toBe(false);
    expect((await patchMarkers(b, alice, old)).status).toBe(400);
  });
});
