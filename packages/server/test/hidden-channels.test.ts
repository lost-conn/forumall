/**
 * §11.3 "Hidden channels answer as missing", walked across every surface.
 *
 * A channel the caller cannot read — whichever of §11.3's three conditions
 * fails — must be answered on every request that names it (or one of its
 * messages) exactly as a channel that does not exist: the same `404` problem
 * over REST, the same `not_found` `error` over WebSocket. A `403` is left only
 * for a reader who lacks a permission (`manage` here; react/type/post in
 * `reader-participation.test.ts`).
 *
 * The hidden channel is built three ways, each hiding it from `eve`, who
 * authored a message there while she could still read it (so edit and delete
 * also prove that read access is checked before authorship):
 *
 *  1. **group unreadable** — `private` group, `public` channel; eve is removed
 *     from the group;
 *  2. **channel tier** — `public` group, `group`-tier channel; eve is removed;
 *  3. **`view` override** — `public` group and channel; eve stays a `member`
 *     but the channel's `permissions.view` narrows to `["admin"]`.
 *
 * Each request is sent twice — naming the hidden channel and naming a channel
 * id that does not exist in the same group (same message id) — and the two
 * answers must be identical once the channel id itself is normalised away.
 * The channel-join alias (§8.2) is deliberately not walked: it answers as a
 * group join. The read-marker "unknown scope" answer is covered by
 * `read-markers.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type WsEnvelope, rfc3339Timestamp } from "@forumall/shared";
import { and, eq } from "drizzle-orm";

import { groupMembers } from "../src/db/schema.ts";
import {
  http,
  type Booted,
  type Signer,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-hidden-channels-");

/** A channel id that does not exist anywhere. */
const MISSING = "chn_doesnotexist";

type Construction = "group unreadable" | "channel tier" | "view override";
const CONSTRUCTIONS: readonly Construction[] = [
  "group unreadable",
  "channel tier",
  "view override",
];

interface Fixture {
  b: Booted;
  owner: Signer;
  eve: Signer;
  groupId: string;
  channelId: string;
  /** A message eve authored while she could read the channel. */
  eveMessageId: string;
}

function addMember(b: Booted, groupId: string, signer: Signer, role: string): void {
  b.db.drizzle
    .insert(groupMembers)
    .values({ groupId, user: signer.actor, role, joinedAt: Date.now() })
    .run();
}

function removeMember(b: Booted, groupId: string, signer: Signer): void {
  b.db.drizzle
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.user, signer.actor)))
    .run();
}

async function postMessage(
  b: Booted,
  author: Signer,
  groupId: string,
  channelId: string,
): Promise<string> {
  const res = await signedReq(
    b,
    author,
    "POST",
    `/api/groups/${groupId}/channels/${channelId}/messages`,
    {
      content: { mime: "text/plain", text: "hello" },
    },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Build the channel, let eve post in it, then hide it from her per `how`. */
async function hiddenChannel(how: Construction, transport: string): Promise<Fixture> {
  const b = boot(`hidden-${transport}-${how.replace(/\W/g, "-")}`);
  const owner = await registerUserWithKey(b, "owner");
  const eve = await registerUserWithKey(b, "eve");
  const tiers =
    how === "group unreadable"
      ? { group: "private", channel: "public" }
      : how === "channel tier"
        ? { group: "public", channel: "group" }
        : { group: "public", channel: "public" };

  const g = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: tiers.group });
  expect(g.status).toBe(201);
  const groupId = ((await g.json()) as { id: string }).id;
  const ch = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
    type: "text",
    name: "secret",
    tier: tiers.channel,
  });
  expect(ch.status).toBe(201);
  const channelId = ((await ch.json()) as { id: string }).id;

  addMember(b, groupId, eve, "member");
  const eveMessageId = await postMessage(b, eve, groupId, channelId);

  if (how === "view override") {
    const res = await signedReq(b, owner, "PATCH", `/api/groups/${groupId}/channels/${channelId}`, {
      permissions: { view: ["admin"] },
    });
    expect(res.status).toBe(200);
  } else {
    removeMember(b, groupId, eve);
  }
  return { b, owner, eve, groupId, channelId, eveMessageId };
}

/** Serialise an answer with the named channel id replaced by a placeholder. */
function normalise(value: unknown, channelId: string): string {
  return JSON.stringify(value).replaceAll(channelId, "<channel>");
}

/** A REST answer: status and body (problem bodies are JSON). */
async function answer(res: Response): Promise<{ status: number; body: unknown }> {
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

/** One REST request shape, parameterised by the channel id it names. */
interface RestCase {
  readonly name: string;
  readonly method: string;
  readonly path: (f: Fixture, channelId: string) => string;
  readonly body?: (f: Fixture, channelId: string) => unknown;
  /** Also send it unsigned (an anonymous viewer, §4.5). */
  readonly anonymous?: boolean;
}

const base = (f: Fixture, c: string) => `/api/groups/${f.groupId}/channels/${c}`;
const msg = (f: Fixture, c: string) => `${base(f, c)}/messages/${f.eveMessageId}`;

const REST_CASES: readonly RestCase[] = [
  { name: "GET channel", method: "GET", path: base, anonymous: true },
  { name: "PATCH channel", method: "PATCH", path: base, body: () => ({ name: "renamed" }) },
  { name: "DELETE channel", method: "DELETE", path: base },
  { name: "GET history", method: "GET", path: (f, c) => `${base(f, c)}/messages`, anonymous: true },
  { name: "GET replies", method: "GET", path: (f, c) => `${msg(f, c)}/replies`, anonymous: true },
  {
    name: "GET reactions",
    method: "GET",
    path: (f, c) => `${msg(f, c)}/reactions`,
    anonymous: true,
  },
  {
    name: "POST message",
    method: "POST",
    path: (f, c) => `${base(f, c)}/messages`,
    body: () => ({ content: { mime: "text/plain", text: "sneaky" } }),
  },
  {
    name: "PATCH own message",
    method: "PATCH",
    path: msg,
    body: () => ({ content: { mime: "text/plain", text: "edited" } }),
  },
  { name: "DELETE own message", method: "DELETE", path: msg },
  {
    name: "PUT reaction",
    method: "PUT",
    path: (f, c) => `${msg(f, c)}/reactions/heart`,
    body: () => ({}),
  },
  { name: "DELETE reaction", method: "DELETE", path: (f, c) => `${msg(f, c)}/reactions/heart` },
  {
    name: "POST follow",
    method: "POST",
    path: () => "/api/me/follows",
    body: (_f, c) => ({ channel: c }),
  },
];

/** One WS command, parameterised by the channel id it names. */
interface WsCase {
  readonly type: string;
  readonly data: (f: Fixture, channelId: string) => Record<string, unknown>;
}

const target = (f: Fixture, c: string) => ({ groupId: f.groupId, channelId: c });
const WS_CASES: readonly WsCase[] = [
  { type: "subscribe", data: (_f, c) => ({ channels: [c] }) },
  {
    type: "message.create",
    data: (f, c) => ({ ...target(f, c), content: { mime: "text/plain", text: "sneaky" } }),
  },
  {
    type: "message.update",
    data: (f, c) => ({
      ...target(f, c),
      messageId: f.eveMessageId,
      content: { mime: "text/plain", text: "edited" },
    }),
  },
  { type: "message.delete", data: (f, c) => ({ ...target(f, c), messageId: f.eveMessageId }) },
  {
    type: "reaction.add",
    data: (f, c) => ({ ...target(f, c), messageId: f.eveMessageId, key: "heart" }),
  },
  {
    type: "reaction.remove",
    data: (f, c) => ({ ...target(f, c), messageId: f.eveMessageId, key: "heart" }),
  },
  { type: "typing.start", data: (_f, c) => ({ channelId: c }) },
];

/** Send one WS command and return the `error` answering it. */
async function wsError(
  conn: Awaited<ReturnType<typeof connectAuthenticated>>,
  id: string,
  type: string,
  data: Record<string, unknown>,
): Promise<WsEnvelope> {
  conn.send({ id, type, ts: rfc3339Timestamp(), data });
  return conn.next((f) => f.type === "error" && f.correlationId === id);
}

/** The fixture's channel and eve's message are untouched (no side effect). */
async function expectUntouched(f: Fixture): Promise<void> {
  const ch = await signedReq(f.b, f.owner, "GET", base(f, f.channelId));
  expect(ch.status).toBe(200);
  expect(((await ch.json()) as { name: string }).name).toBe("secret");
  const hist = await signedReq(f.b, f.owner, "GET", `${base(f, f.channelId)}/messages`);
  const items = ((await hist.json()) as { items: { id: string; content: { text: string } }[] })
    .items;
  expect(items.map((m) => [m.id, m.content.text])).toEqual([[f.eveMessageId, "hello"]]);
  const rx = await signedReq(f.b, f.owner, "GET", `${msg(f, f.channelId)}/reactions`);
  expect(((await rx.json()) as { items: unknown[] }).items).toEqual([]);
}

describe("hidden channels answer as missing on every surface (§11.3)", () => {
  for (const how of CONSTRUCTIONS) {
    test(`REST, ${how}: every request answers exactly as for a missing channel`, async () => {
      const f = await hiddenChannel(how, "rest");
      for (const c of REST_CASES) {
        const send = (channelId: string) =>
          signedReq(f.b, f.eve, c.method, c.path(f, channelId), c.body?.(f, channelId));
        const hidden = await answer(await send(f.channelId));
        const missing = await answer(await send(MISSING));
        expect({ case: c.name, status: hidden.status }).toEqual({ case: c.name, status: 404 });
        expect(normalise(hidden, f.channelId)).toBe(normalise(missing, MISSING));

        if (c.anonymous) {
          const anon = (channelId: string) => http(f.b, c.path(f, channelId), { method: c.method });
          const anonHidden = await answer(await anon(f.channelId));
          const anonMissing = await answer(await anon(MISSING));
          expect({ case: `${c.name} (anonymous)`, status: anonHidden.status }).toEqual({
            case: `${c.name} (anonymous)`,
            status: 404,
          });
          expect(normalise(anonHidden, f.channelId)).toBe(normalise(anonMissing, MISSING));
        }
      }
      await expectUntouched(f);
    });

    test(`WebSocket, ${how}: every command answers exactly as for a missing channel`, async () => {
      const f = await hiddenChannel(how, "ws");
      // The owner watches the channel: nothing eve sends may reach it.
      const watcher = await connectAuthenticated(f.b, f.owner);
      watcher.send({ id: "w", type: "subscribe", data: { channels: [f.channelId] } });
      await watcher.ofType("subscribed");

      const conn = await connectAuthenticated(f.b, f.eve);
      for (const c of WS_CASES) {
        const hidden = await wsError(conn, `${c.type}-h`, c.type, c.data(f, f.channelId));
        const missing = await wsError(conn, `${c.type}-m`, c.type, c.data(f, MISSING));
        expect({ case: c.type, code: (hidden.data as { code: string }).code }).toEqual({
          case: c.type,
          code: "not_found",
        });
        expect(normalise(hidden.data, f.channelId)).toBe(normalise(missing.data, MISSING));
      }
      expect(await watcher.none((e) => e.type !== "pong" && e.type !== "ping")).toBe(true);
      conn.close();
      watcher.close();
      await expectUntouched(f);
    });
  }
});

describe("403 only for a reader who lacks a permission (§11.3)", () => {
  test("a `manage` holder outside `view` gets 404 on PATCH/DELETE; a reader without `manage` gets 403", async () => {
    const b = boot("hidden-manage");
    const owner = await registerUserWithKey(b, "owner");
    const admin = await registerUserWithKey(b, "admin");
    const member = await registerUserWithKey(b, "member");
    const g = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: "public" });
    const groupId = ((await g.json()) as { id: string }).id;
    addMember(b, groupId, admin, "admin");
    addMember(b, groupId, member, "member");
    // Default permissions: `manage` is ["admin"]; `view` leaves the admin out.
    const ch = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
      type: "text",
      tier: "public",
      permissions: { view: ["member"] },
    });
    const channelId = ((await ch.json()) as { id: string }).id;
    const path = `/api/groups/${groupId}/channels/${channelId}`;
    const missingPath = `/api/groups/${groupId}/channels/${MISSING}`;

    for (const method of ["PATCH", "DELETE"]) {
      const body = method === "PATCH" ? { permissions: {} } : undefined;
      const hidden = await answer(await signedReq(b, admin, method, path, body));
      const missing = await answer(await signedReq(b, admin, method, missingPath, body));
      expect(hidden.status).toBe(404);
      expect(normalise(hidden, channelId)).toBe(normalise(missing, MISSING));

      // The member can read the channel but lacks `manage`.
      expect((await signedReq(b, member, method, path, body)).status).toBe(403);
    }
    // The admin could not widen `view` to themselves: the channel is unchanged.
    const after = await signedReq(b, owner, "GET", path);
    expect(((await after.json()) as { permissions?: unknown }).permissions).toEqual({
      view: ["member"],
    });
  });

  test("an author who can still read gets 403 editing another's message, not 404", async () => {
    const b = boot("hidden-author");
    const owner = await registerUserWithKey(b, "owner");
    const eve = await registerUserWithKey(b, "eve");
    const g = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: "public" });
    const groupId = ((await g.json()) as { id: string }).id;
    const ch = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
      type: "text",
      tier: "public",
    });
    const channelId = ((await ch.json()) as { id: string }).id;
    const ownerMessage = await postMessage(b, owner, groupId, channelId);
    const path = `/api/groups/${groupId}/channels/${channelId}/messages/${ownerMessage}`;

    // eve is an anonymous-tier reader (not a member) of the public channel.
    const edit = await signedReq(b, eve, "PATCH", path, {
      content: { mime: "text/plain", text: "x" },
    });
    expect(edit.status).toBe(403);
    expect((await signedReq(b, eve, "DELETE", path)).status).toBe(403);
  });
});
