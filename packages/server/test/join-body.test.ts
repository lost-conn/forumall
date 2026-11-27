/**
 * The optional `POST /api/groups/{groupId}/join` body (spec §5.7,
 * `join-create-request.json`). An absent or zero-length body is fine. Any
 * other body must be JSON on every join — open, invite, existing member,
 * request — and a non-JSON body is `400` before any answer the join policy
 * gives. The schema (`message` an optional string; `null` refused) is checked
 * only for a non-member joining a `request`-policy group, including a repeat
 * while a request is pending; elsewhere the JSON body is ignored. Shared setup
 * is `helpers/membership-app.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type JoinRequest, sign } from "@forumall/shared";

import {
  type App,
  DOMAIN,
  type Signer,
  createGroup,
  registerUserWithKey,
  seedMember,
  signedRequest,
  useMembershipApp,
} from "./helpers/membership-app.ts";

const freshApp = useMembershipApp("join-body");

/**
 * POST `/join` (or, with `channelId`, the channel alias) with `body` sent
 * byte-for-byte, signed over those bytes.
 */
function joinRaw(app: App, signer: Signer, groupId: string, body: string, channelId?: string) {
  const path =
    channelId === undefined
      ? `/api/groups/${groupId}/join`
      : `/api/groups/${groupId}/channels/${channelId}/join`;
  const { headers } = sign({
    actor: signer.actor,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    authority: DOMAIN,
    method: "POST",
    path,
    query: "",
    body,
  });
  return app.request(path, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
  });
}

async function setup(name: string, joinPolicy: "open" | "invite" | "request") {
  const { app, db } = freshApp(name);
  const owner = await registerUserWithKey(app, "owner");
  const joiner = await registerUserWithKey(app, "joiner");
  const group = await createGroup(app, owner, { name: "G", tier: "public", joinPolicy });
  return { app, db, owner, joiner, group };
}

describe("join body: a non-JSON body is 400 on every join (§5.7)", () => {
  for (const policy of ["open", "invite", "request"] as const) {
    test(`${policy} group: body \`abc\` → 400 bad_request`, async () => {
      const { app, joiner, group } = await setup(`nonjson-${policy}`, policy);
      const res = await joinRaw(app, joiner, group.id, "abc");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { errorCode: string }).errorCode).toBe("bad_request");
    });
  }

  test("an existing member sending `abc` → 400, not the idempotent 200", async () => {
    const { app, db, joiner, group } = await setup("nonjson-member", "open");
    seedMember(db, group.id, joiner.actor, "member");
    const res = await joinRaw(app, joiner, group.id, "abc");
    expect(res.status).toBe(400);
  });

  test("the channel join alias answers the same: `abc` → 400, `message: null` → 400", async () => {
    const { app, owner, joiner, group } = await setup("alias", "request");
    const created = await signedRequest(app, owner, "POST", `/api/groups/${group.id}/channels`, {
      name: "general",
      type: "text",
    });
    expect(created.status).toBe(201);
    const channelId = ((await created.json()) as { id: string }).id;

    expect((await joinRaw(app, joiner, group.id, "abc", channelId)).status).toBe(400);
    expect(
      (await joinRaw(app, joiner, group.id, JSON.stringify({ message: null }), channelId)).status,
    ).toBe(400);
    expect((await joinRaw(app, joiner, group.id, "", channelId)).status).toBe(202);
  });
});

describe("join body: the schema is checked only under the request policy (§5.7)", () => {
  test("request group: `message: null` → 400; a non-string message → 400", async () => {
    const { app, joiner, group } = await setup("req-null", "request");
    const nul = await signedRequest(app, joiner, "POST", `/api/groups/${group.id}/join`, {
      message: null,
    });
    expect(nul.status).toBe(400);
    const num = await signedRequest(app, joiner, "POST", `/api/groups/${group.id}/join`, {
      message: 5,
    });
    expect(num.status).toBe(400);
  });

  test("request group: absent body, zero-length body and `{}` → 202", async () => {
    for (const [i, send] of [
      (app: App, s: Signer, g: string) => signedRequest(app, s, "POST", `/api/groups/${g}/join`),
      (app: App, s: Signer, g: string) => joinRaw(app, s, g, ""),
      (app: App, s: Signer, g: string) =>
        signedRequest(app, s, "POST", `/api/groups/${g}/join`, {}),
    ].entries()) {
      const { app, joiner, group } = await setup(`req-empty-${i}`, "request");
      const res = await send(app, joiner, group.id);
      expect(res.status).toBe(202);
    }
  });

  test("request group: a string message is stored; a pending repeat is checked too", async () => {
    const { app, joiner, group } = await setup("req-message", "request");
    const res = await signedRequest(app, joiner, "POST", `/api/groups/${group.id}/join`, {
      message: "let me in",
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as JoinRequest).message).toBe("let me in");

    const repeat = await signedRequest(app, joiner, "POST", `/api/groups/${group.id}/join`, {
      message: null,
    });
    expect(repeat.status).toBe(400);
  });

  test("open group: a JSON body is ignored (`message: null` still joins, 201)", async () => {
    const { app, joiner, group } = await setup("open-ignored", "open");
    const res = await signedRequest(app, joiner, "POST", `/api/groups/${group.id}/join`, {
      message: null,
    });
    expect(res.status).toBe(201);
  });

  test("invite group: a JSON body is ignored (`message: null` → the policy's 403)", async () => {
    const { app, joiner, group } = await setup("invite-ignored", "invite");
    const res = await signedRequest(app, joiner, "POST", `/api/groups/${group.id}/join`, {
      message: null,
    });
    expect(res.status).toBe(403);
  });

  test("existing member: a JSON body is ignored (`message: null` → 200)", async () => {
    const { app, db, joiner, group } = await setup("member-ignored", "request");
    seedMember(db, group.id, joiner.actor, "member");
    const res = await signedRequest(app, joiner, "POST", `/api/groups/${group.id}/join`, {
      message: null,
    });
    expect(res.status).toBe(200);
  });
});
