/**
 * §11 "Reading never implies posting", for reactions and typing, and the
 * §5.2.1 `react` permission.
 *
 * A non-member who can read a `public` channel must not react or type in it:
 * those need membership plus the relevant permission. She can read, so the
 * answer is `403` (§11.3), never the hidden-channel `404`.
 *
 *  - `react` is an exact-membership grant (§5.2.1): only listed roles (and the
 *    owner) may react — no rank inheritance. Absent, it falls back to "any
 *    actor permitted to read the channel", i.e. any member who can read — NOT
 *    the group's `post` action.
 *  - `react` gates adding; withdrawing one's own reaction needs read access
 *    only (e.g. after leaving the group).
 *  - Typing needs read access and a `post:<type>` grant (§7.1), which a
 *    non-member never holds; the grant rule itself is in
 *    `typing-permissions.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { rfc3339Timestamp } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import { groupMembers } from "../src/db/schema.ts";
import {
  type Booted,
  type Signer,
  type WsClient,
  addMember,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-reader-participation-");

interface Fixture {
  b: Booted;
  owner: Signer;
  groupId: string;
  channelId: string;
  messageId: string;
}

/** A `public` group + channel (optionally with `permissions`) and one message. */
async function publicChannel(name: string, permissions?: unknown): Promise<Fixture> {
  const b = boot(name);
  const owner = await registerUserWithKey(b, "owner");
  const g = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: "public" });
  expect(g.status).toBe(201);
  const groupId = ((await g.json()) as { id: string }).id;
  const ch = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
    type: "text",
    tier: "public",
    ...(permissions !== undefined ? { permissions } : {}),
  });
  expect(ch.status).toBe(201);
  const channelId = ((await ch.json()) as { id: string }).id;
  const m = await signedReq(
    b,
    owner,
    "POST",
    `/api/groups/${groupId}/channels/${channelId}/messages`,
    {
      content: { mime: "text/plain", text: "hi" },
    },
  );
  expect(m.status).toBe(201);
  const messageId = ((await m.json()) as { id: string }).id;
  return { b, owner, groupId, channelId, messageId };
}

const reactionsPath = (f: Fixture) =>
  `/api/groups/${f.groupId}/channels/${f.channelId}/messages/${f.messageId}/reactions`;
const reactionPath = (f: Fixture, key: string) => `${reactionsPath(f)}/${key}`;

function sendCommand(conn: WsClient, id: string, type: string, data: Record<string, unknown>) {
  conn.send({ id, type, ts: rfc3339Timestamp(), data });
}

interface ErrorData {
  code: string;
  status: number;
  message: string;
}

async function errorFor(conn: WsClient, id: string): Promise<ErrorData> {
  const err = await conn.next((f) => f.type === "error" && f.correlationId === id);
  return err.data as ErrorData;
}

describe("a non-member reader of a public channel may not react or type (§11)", () => {
  test("she can read, but REST and WS reaction adds are 403 and nothing is stored", async () => {
    const f = await publicChannel("rp-react");
    const rita = await registerUserWithKey(f.b, "rita");
    const history = `/api/groups/${f.groupId}/channels/${f.channelId}/messages`;
    expect((await signedReq(f.b, rita, "GET", history)).status).toBe(200);

    const put = await signedReq(f.b, rita, "PUT", reactionPath(f, "heart"), {});
    expect(put.status).toBe(403);
    expect(((await put.json()) as { errorCode: string }).errorCode).toBe("forbidden");

    const conn = await connectAuthenticated(f.b, rita);
    sendCommand(conn, "rx", "reaction.add", {
      groupId: f.groupId,
      channelId: f.channelId,
      messageId: f.messageId,
      key: "heart",
    });
    expect(await errorFor(conn, "rx")).toMatchObject({ code: "forbidden", status: 403 });
    conn.close();

    const list = await signedReq(f.b, f.owner, "GET", reactionsPath(f));
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test("typing.start is 403 with no fan-out; a typing.stop she never started fans out nothing", async () => {
    const f = await publicChannel("rp-typing");
    const rita = await registerUserWithKey(f.b, "rita");
    const watcher = await connectAuthenticated(f.b, f.owner);
    await subscribe(watcher, f.channelId);

    const conn = await connectAuthenticated(f.b, rita);
    await subscribe(conn, f.channelId); // a live reader, as §11 describes
    sendCommand(conn, "ty", "typing.start", { channelId: f.channelId });
    expect(await errorFor(conn, "ty")).toMatchObject({ code: "forbidden", status: 403 });
    sendCommand(conn, "ts", "typing.stop", { channelId: f.channelId });

    expect(await watcher.none((e) => e.type === "channel.typing")).toBe(true);
    conn.close();
    watcher.close();
  });

  test("membership alone is not the bar: a member with no `post` grant may not type (§7.1)", async () => {
    const f = await publicChannel("rp-typing-guest");
    const gus = await registerUserWithKey(f.b, "gus");
    addMember(f.b, f.groupId, gus, "guest"); // `guest` cannot post by default
    const watcher = await connectAuthenticated(f.b, f.owner);
    await subscribe(watcher, f.channelId);

    const conn = await connectAuthenticated(f.b, gus);
    sendCommand(conn, "ty", "typing.start", { channelId: f.channelId });
    expect(await errorFor(conn, "ty")).toMatchObject({ code: "forbidden", status: 403 });
    sendCommand(conn, "ts", "typing.stop", { channelId: f.channelId });
    expect(await watcher.none((e) => e.type === "channel.typing")).toBe(true);
    conn.close();
    watcher.close();
  });
});

describe("the `react` permission (§5.2.1)", () => {
  test("an override is exact membership: listed roles and the owner only, no rank inheritance", async () => {
    const f = await publicChannel("rp-react-exact", { react: ["member"] });
    const admin = await registerUserWithKey(f.b, "admin");
    const member = await registerUserWithKey(f.b, "member");
    addMember(f.b, f.groupId, admin, "admin");
    addMember(f.b, f.groupId, member, "member");

    expect((await signedReq(f.b, admin, "PUT", reactionPath(f, "a"), {})).status).toBe(403);
    expect((await signedReq(f.b, member, "PUT", reactionPath(f, "m"), {})).status).toBe(201);
    expect((await signedReq(f.b, f.owner, "PUT", reactionPath(f, "o"), {})).status).toBe(201);
  });

  test("without an override any member may react, even one the group's `post` excludes", async () => {
    const f = await publicChannel("rp-react-default");
    const gus = await registerUserWithKey(f.b, "gus");
    addMember(f.b, f.groupId, gus, "guest");

    expect((await signedReq(f.b, gus, "PUT", reactionPath(f, "g"), {})).status).toBe(201);
  });

  test("a reader who left the group may still withdraw her own reaction", async () => {
    const f = await publicChannel("rp-react-withdraw");
    const rita = await registerUserWithKey(f.b, "rita");
    addMember(f.b, f.groupId, rita, "member");
    expect((await signedReq(f.b, rita, "PUT", reactionPath(f, "heart"), {})).status).toBe(201);

    f.b.db.drizzle
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, f.groupId), eq(groupMembers.user, rita.actor)))
      .run();
    // No longer a member: adding is refused, withdrawing is not.
    expect((await signedReq(f.b, rita, "PUT", reactionPath(f, "star"), {})).status).toBe(403);
    expect((await signedReq(f.b, rita, "DELETE", reactionPath(f, "heart"))).status).toBe(204);

    const list = await signedReq(f.b, f.owner, "GET", reactionsPath(f));
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });
});
