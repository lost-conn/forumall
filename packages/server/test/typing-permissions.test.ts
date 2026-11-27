/**
 * §7.1 "Typing indicators": who may type in a channel, what the requester gets
 * back, and that typing is the actor's state across its connections.
 *
 *  - `typing.start` needs read access and at least one `post:<type>` grant,
 *    for any `type` (a channel override or the group's `post`); a
 *    reply-restricted actor holds one. Without one: `forbidden`, no fan-out.
 *  - A successful start is not acknowledged: no frame carries its `id`.
 *  - A `typing.stop` with no active start (never started, expired, already
 *    stopped) sends nothing, to subscribers or the requester; a stop naming a
 *    missing or unreadable channel is `not_found`.
 *  - A stop from any connection of the actor ends its typing there; a timer or
 *    disconnect of one connection does not, while another still types.
 *
 * The non-member reader case is in `reader-participation.test.ts`; fan-out,
 * expiry and disconnect basics in `typing.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { type WsEnvelope, rfc3339Timestamp } from "@forumall/shared";

import {
  type Booted,
  FAST_TIMINGS,
  type Signer,
  type WsClient,
  addMember,
  connectAuthenticated,
  registerUserWithKey,
  signedReq,
  subscribe,
  useWsBoot,
} from "./helpers/ws-harness.ts";

const boot = useWsBoot("forumall-typing-permissions-");

/** A short typing timeout so expiry cases resolve quickly. */
const TYPING_TIMEOUT_MS = 200;

interface Fixture {
  b: Booted;
  owner: Signer;
  groupId: string;
  channelId: string;
  /** The owner, subscribed: sees every `channel.typing`. */
  watcher: WsClient;
}

async function fixture(
  name: string,
  channel: { tier?: string; permissions?: Record<string, unknown> } = {},
): Promise<Fixture> {
  const b = boot(name, FAST_TIMINGS, { TYPING_TIMEOUT_MS: String(TYPING_TIMEOUT_MS) });
  const owner = await registerUserWithKey(b, "owner");
  const g = await signedReq(b, owner, "POST", "/api/groups", { name: "g", tier: "public" });
  expect(g.status).toBe(201);
  const groupId = ((await g.json()) as { id: string }).id;
  const ch = await signedReq(b, owner, "POST", `/api/groups/${groupId}/channels`, {
    type: "text",
    tier: channel.tier ?? "public",
    ...(channel.permissions !== undefined ? { permissions: channel.permissions } : {}),
  });
  expect(ch.status).toBe(201);
  const channelId = ((await ch.json()) as { id: string }).id;
  const watcher = await connectAuthenticated(b, owner);
  await subscribe(watcher, channelId);
  return { b, owner, groupId, channelId, watcher };
}

/** A member of the fixture's group with `role`, connected. */
async function memberConn(f: Fixture, handle: string, role: string): Promise<WsClient> {
  const signer = await registerUserWithKey(f.b, handle);
  addMember(f.b, f.groupId, signer, role);
  return connectAuthenticated(f.b, signer);
}

function command(conn: WsClient, id: string, type: string, data: Record<string, unknown>): void {
  conn.send({ id, type, ts: rfc3339Timestamp(), data });
}

const typing = (state?: "start" | "stop") => (frame: WsEnvelope) =>
  frame.type === "channel.typing" &&
  (state === undefined || (frame.data as { state: string }).state === state);
const correlated = (id: string) => (frame: WsEnvelope) => frame.correlationId === id;

describe("who may type in a channel (§7.1)", () => {
  test("a `post:<type>` grant for any one type is enough", async () => {
    // `guest` holds no group `post`, but this channel grants it `post:memo`.
    const f = await fixture("ty-grant-memo", { permissions: { "post:memo": ["guest"] } });
    const gus = await memberConn(f, "gus", "guest");
    command(gus, "ty", "typing.start", { channelId: f.channelId });
    expect((await f.watcher.next(typing("start"))).data).toMatchObject({ state: "start" });
    expect(await gus.none(correlated("ty"))).toBe(true);
  });

  test("a member whose every `post:<type>` is withheld is forbidden, and nothing is fanned out", async () => {
    const f = await fixture("ty-grant-none", {
      permissions: { "post:message": [], "post:memo": [], "post:article": [] },
    });
    const mia = await memberConn(f, "mia", "member");
    command(mia, "ty", "typing.start", { channelId: f.channelId });
    const err = await mia.next(correlated("ty"));
    expect(err.type).toBe("error");
    expect(err.data).toMatchObject({ code: "forbidden", status: 403 });
    expect(await f.watcher.none(typing())).toBe(true);
  });

  test("a reply-restricted member holds a post grant, so may type", async () => {
    const f = await fixture("ty-reply-only", { permissions: { replyOnly: ["member"] } });
    const rex = await memberConn(f, "rex", "member");
    command(rex, "ty", "typing.start", { channelId: f.channelId });
    expect((await f.watcher.next(typing("start"))).data).toMatchObject({ state: "start" });
  });
});

describe("what the requester gets back (§7.1)", () => {
  test("a successful start is not acknowledged, even to a subscribed requester", async () => {
    const f = await fixture("ty-no-ack");
    const mia = await memberConn(f, "mia", "member");
    await subscribe(mia, f.channelId);
    command(mia, "ty", "typing.start", { channelId: f.channelId });
    await f.watcher.next(typing("start"));
    // Its own subscription sees the uncorrelated fan-out; nothing carries `ty`.
    expect((await mia.next(typing("start"))).correlationId).toBeUndefined();
    expect(await mia.none(correlated("ty"))).toBe(true);
  });

  test("a stop with no active start sends nothing: never started, expired, or already stopped", async () => {
    const f = await fixture("ty-noop-stop");
    const mia = await memberConn(f, "mia", "member");
    await subscribe(mia, f.channelId);

    command(mia, "never", "typing.stop", { channelId: f.channelId });
    expect(await f.watcher.none(typing())).toBe(true);
    expect(
      await mia.none((frame) => frame.type === "channel.typing" || frame.correlationId === "never"),
    ).toBe(true);

    // Started, then expired: the automatic stop is the only one.
    command(mia, "start1", "typing.start", { channelId: f.channelId });
    await f.watcher.next(typing("start"));
    await f.watcher.next(typing("stop"), TYPING_TIMEOUT_MS * 6);
    command(mia, "late", "typing.stop", { channelId: f.channelId });
    expect(await f.watcher.none(typing())).toBe(true);

    // Started, stopped, stopped again: one stop.
    command(mia, "start2", "typing.start", { channelId: f.channelId });
    await f.watcher.next(typing("start"));
    command(mia, "stop1", "typing.stop", { channelId: f.channelId });
    await f.watcher.next(typing("stop"));
    command(mia, "stop2", "typing.stop", { channelId: f.channelId });
    expect(await f.watcher.none(typing())).toBe(true);
    expect(await mia.none(correlated("stop2"))).toBe(true);
  });

  test("a stop naming a missing or unreadable channel is not_found", async () => {
    const f = await fixture("ty-stop-hidden", { tier: "private" });
    const outsider = await connectAuthenticated(f.b, await registerUserWithKey(f.b, "olly"));
    for (const [id, channelId] of [
      ["hidden", f.channelId],
      ["missing", "chn_does_not_exist"],
    ] as const) {
      command(outsider, id, "typing.stop", { channelId });
      const err = await outsider.next(correlated(id));
      expect(err.type).toBe("error");
      expect(err.data).toMatchObject({ code: "not_found", status: 404 });
    }
    expect(await f.watcher.none(typing())).toBe(true);
  });

  test("a stop naming neither a channel nor a DM is bad_request", async () => {
    const f = await fixture("ty-stop-target");
    const mia = await memberConn(f, "mia", "member");
    command(mia, "empty", "typing.stop", {});
    expect((await mia.next(correlated("empty"))).data).toMatchObject({ code: "bad_request" });
  });
});

describe("typing is the actor's, across its connections (§7.1)", () => {
  test("a stop from another connection ends the start, and the first connection's timer adds no second stop", async () => {
    const f = await fixture("ty-cross-stop");
    const signer = await registerUserWithKey(f.b, "mia");
    addMember(f.b, f.groupId, signer, "member");
    const phone = await connectAuthenticated(f.b, signer);
    const laptop = await connectAuthenticated(f.b, signer);

    command(phone, "start", "typing.start", { channelId: f.channelId });
    await f.watcher.next(typing("start"));
    command(laptop, "stop", "typing.stop", { channelId: f.channelId });
    expect((await f.watcher.next(typing("stop"))).data).toMatchObject({ user: signer.actor });
    expect(await f.watcher.none(typing(), TYPING_TIMEOUT_MS * 3)).toBe(true);
  });

  test("one connection closing or expiring does not stop the actor while another still types", async () => {
    const f = await fixture("ty-cross-drop");
    const signer = await registerUserWithKey(f.b, "mia");
    addMember(f.b, f.groupId, signer, "member");
    const phone = await connectAuthenticated(f.b, signer);
    const laptop = await connectAuthenticated(f.b, signer);

    command(phone, "p", "typing.start", { channelId: f.channelId });
    await f.watcher.next(typing("start"));
    command(laptop, "l", "typing.start", { channelId: f.channelId });
    await f.watcher.next(typing("start"));

    // The phone drops: the laptop still types, so no stop yet.
    phone.close();
    await phone.waitClosed();
    expect(await f.watcher.none(typing("stop"), TYPING_TIMEOUT_MS / 2)).toBe(true);
    // The laptop's start then lapses: exactly one automatic stop.
    await f.watcher.next(typing("stop"), TYPING_TIMEOUT_MS * 6);
    expect(await f.watcher.none(typing(), TYPING_TIMEOUT_MS * 2)).toBe(true);
  });
});
