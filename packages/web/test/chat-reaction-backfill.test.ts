/**
 * Reaction backfill for REST-loaded channel messages (`chat-controller.ts` +
 * `reaction-backfill.ts`).
 *
 * History and reply listings hold messages only (§7.2, lost-conn/ofscp#37), so
 * every path that loads messages (the first page, each older page, a reply
 * listing) must fetch each message's `…/reactions`. These cases drive the real
 * controller against a scripted client + WS stand-in and read the chat store.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Message, Reaction, WsEnvelope } from "@forumall/shared";
import { loadReplies, openChannel } from "../src/components/chat/chat-controller.ts";
import {
  REACTION_FETCH_CONCURRENCY,
  backfillReactions,
} from "../src/components/chat/reaction-backfill.ts";
import type { OfscpClient } from "../src/lib/ofscp-client.ts";
import type { OfscpWsClient } from "../src/lib/ofscp-ws.ts";
import { clearChat, messagesFor, reactionsFor } from "../src/stores/chat.ts";

const G = "g1";
const CH = "ch1";
const BASE = `/api/groups/${G}/channels/${CH}/messages`;

function message(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    author: "alice@h",
    type: "message",
    content: { mime: "text/plain", text: id },
    createdAt: "2026-06-05T00:00:00Z",
    ...over,
  } as Message;
}

function reaction(messageId: string, key: string, author = "bob@h"): Reaction {
  return {
    id: `rx_${messageId}_${key}_${author}`,
    author,
    key,
    reference: { type: "message", id: messageId },
    createdAt: "2026-06-05T00:00:00Z",
    metadata: [],
  } as Reaction;
}

/** A deferred response, so a test can act while a request is in flight. */
interface Pending {
  path: string;
  resolve(data: unknown): void;
  reject(err: Error): void;
}

/**
 * A scripted `OfscpClient`: `routes` answers a GET path at once; any other GET
 * waits in `pending` until the test settles it. `gets` records every path.
 */
function fakeClient(routes: Record<string, unknown>) {
  const gets: string[] = [];
  const pending: Pending[] = [];
  const client = {
    async get(path: string) {
      gets.push(path);
      if (path in routes) return { data: routes[path] };
      return new Promise((resolve, reject) => {
        pending.push({
          path,
          resolve: (data) => resolve({ data }),
          reject,
        });
      });
    },
  } as unknown as OfscpClient;
  return { client, gets, pending };
}

/** A WS stand-in: records listeners so a test can deliver events to them. */
function fakeWs() {
  const listeners = new Map<string, Set<(e: WsEnvelope) => void>>();
  const ws = {
    on(type: string, cb: (e: WsEnvelope) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
      return () => set.delete(cb);
    },
    subscribe() {},
    unsubscribe() {},
  } as unknown as OfscpWsClient;
  const emit = (type: string, data: Record<string, unknown>): void => {
    for (const cb of listeners.get(type) ?? []) {
      cb({ type, ts: "2026-06-05T00:00:00Z", data } as WsEnvelope);
    }
  };
  return { ws, emit };
}

const page = (items: Message[], nextCursor: string | null = null) => ({
  items,
  page: { nextCursor },
});

/** Let queued microtasks (resolved fetches and the folds after them) run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const keysFor = (messageId: string) =>
  reactionsFor(CH, messageId).map((g) => `${g.key}:${g.authors.join(",")}`);

beforeEach(() => clearChat());

describe("every REST message load backfills reactions", () => {
  test("the first page fetches each message's reactions", async () => {
    const { client } = fakeClient({
      [`${BASE}?limit=50&direction=backward`]: page([message("m2"), message("m1")]),
      [`${BASE}/m1/reactions`]: { items: [reaction("m1", "+1")] },
      [`${BASE}/m2/reactions`]: { items: [reaction("m2", "heart")] },
    });
    const handle = await openChannel({ client, ws: fakeWs().ws, groupId: G, channelId: CH });
    expect(keysFor("m1")).toEqual(["+1:bob@h"]);
    expect(keysFor("m2")).toEqual(["heart:bob@h"]);
    handle.close();
  });

  test("an older page fetches its messages' reactions before loadOlder resolves", async () => {
    const { client, gets } = fakeClient({
      [`${BASE}?limit=50&direction=backward`]: page([message("m3")], "c_old"),
      [`${BASE}/m3/reactions`]: { items: [] },
      [`${BASE}?cursor=c_old&limit=50&direction=backward`]: page([message("m2"), message("m1")]),
      [`${BASE}/m1/reactions`]: { items: [reaction("m1", "+1"), reaction("m1", "+1", "carol@h")] },
      [`${BASE}/m2/reactions`]: { items: [reaction("m2", "tada")] },
    });
    const handle = await openChannel({ client, ws: fakeWs().ws, groupId: G, channelId: CH });
    expect(await handle.loadOlder()).toBe(false);
    expect(messagesFor(CH).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(keysFor("m1")).toEqual(["+1:bob@h,carol@h"]);
    expect(keysFor("m2")).toEqual(["tada:bob@h"]);
    expect(gets).toContain(`${BASE}/m1/reactions`);
    expect(gets).toContain(`${BASE}/m2/reactions`);
    handle.close();
  });

  test("a reply listing fetches each reply's reactions", async () => {
    const { client } = fakeClient({
      [`${BASE}/p1/replies?limit=50&direction=forward`]: page([
        message("r1", { reference: { type: "message", id: "p1" } }),
        message("r2", { reference: { type: "message", id: "p1" } }),
      ]),
      [`${BASE}/r1/reactions`]: { items: [reaction("r1", "eyes")] },
      [`${BASE}/r2/reactions`]: { items: [] },
    });
    await loadReplies({ client, groupId: G, channelId: CH, messageId: "p1" });
    expect(messagesFor(CH).map((m) => m.id)).toEqual(["r1", "r2"]);
    expect(keysFor("r1")).toEqual(["eyes:bob@h"]);
    expect(keysFor("r2")).toEqual([]);
  });

  test("a failing listing is skipped; the others still land", async () => {
    const { client, pending } = fakeClient({});
    const done = backfillReactions({ client, groupId: G, channelId: CH }, ["m1", "m2"]);
    await settle();
    const [first, second] = pending;
    first?.reject(new Error("404"));
    second?.resolve({ items: [reaction("m2", "+1")] });
    await done;
    expect(keysFor("m1")).toEqual([]);
    expect(keysFor("m2")).toEqual(["+1:bob@h"]);
  });
});

describe("bounded and in order", () => {
  test("requests start in the given order, never more than the cap at once", async () => {
    const ids = Array.from({ length: REACTION_FETCH_CONCURRENCY * 2 + 1 }, (_, i) => `m${i}`);
    const { client, gets, pending } = fakeClient({});
    const done = backfillReactions({ client, groupId: G, channelId: CH }, ids);
    await settle();
    expect(pending.length).toBe(REACTION_FETCH_CONCURRENCY);
    while (pending.length > 0) {
      const next = pending.shift();
      next?.resolve({ items: [] });
      await settle();
      expect(pending.length).toBeLessThanOrEqual(REACTION_FETCH_CONCURRENCY);
    }
    await done;
    expect(gets).toEqual(ids.map((id) => `${BASE}/${id}/reactions`));
  });
});

describe("live reaction events win over an in-flight listing", () => {
  test("a reaction removed live while its listing is in flight stays removed", async () => {
    const { client, pending } = fakeClient({
      [`${BASE}?limit=50&direction=backward`]: page([message("m1")]),
    });
    const { ws, emit } = fakeWs();
    const opening = openChannel({ client, ws, groupId: G, channelId: CH });
    await settle();
    const listing = pending.find((p) => p.path === `${BASE}/m1/reactions`);
    expect(listing).toBeDefined();
    // The snapshot was taken before bob removed his "+1" and carol added hers.
    emit("reaction.removed", { channelId: CH, messageId: "m1", key: "+1", author: "bob@h" });
    emit("reaction.added", { channelId: CH, reaction: reaction("m1", "+1", "carol@h") });
    listing?.resolve({ items: [reaction("m1", "+1", "bob@h"), reaction("m1", "heart")] });
    const handle = await opening;
    expect(keysFor("m1")).toEqual(["+1:carol@h", "heart:bob@h"]);
    handle.close();
  });

  test("a live event on another message does not mask this one's snapshot", async () => {
    const { client, pending } = fakeClient({});
    const { ws, emit } = fakeWs();
    const handle = await openChannel({
      client: fakeClient({
        [`${BASE}?limit=50&direction=backward`]: page([]),
      }).client,
      ws,
      groupId: G,
      channelId: CH,
    });
    const done = backfillReactions({ client, groupId: G, channelId: CH }, ["m1"]);
    await settle();
    emit("reaction.removed", { channelId: CH, messageId: "m9", key: "+1", author: "bob@h" });
    pending[0]?.resolve({ items: [reaction("m1", "+1")] });
    await done;
    expect(keysFor("m1")).toEqual(["+1:bob@h"]);
    handle.close();
  });
});
