/**
 * Timeline heads (`stores/timeline-heads.ts`): the message auto-mark-read names
 * (§7.7) is the newest one the provider delivered AS the timeline — the newest
 * history page, then live and resumed creates — never the loaded list's last
 * entry, which may be an older message loaded out of timeline order.
 *
 * These cases drive the real chat and DM controllers against a scripted client
 * and WS stand-in, and read the head and the stores. No cursor is decoded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message, WsEnvelope } from "@forumall/shared";
import { loadReplies, openChannel } from "../src/components/chat/chat-controller.ts";
import { openConversation } from "../src/components/dms/dm-controller.ts";
import { startDmSession } from "../src/components/dms/dm-session.ts";
import { DmSentStore } from "../src/lib/dm-store.ts";
import type { OfscpClient } from "../src/lib/ofscp-client.ts";
import type { OfscpWsClient } from "../src/lib/ofscp-ws.ts";
import { clearChat, messagesFor } from "../src/stores/chat.ts";
import { clearDms, dmThread } from "../src/stores/dms.ts";
import { clearTimelineHeads, timelineHeadFor } from "../src/stores/timeline-heads.ts";
import { DM, memBackend } from "./helpers/dm-fixtures.ts";

const G = "g1";
const CH = "ch1";
const BASE = `/api/groups/${G}/channels/${CH}/messages`;
/** The opening (newest) history page; an older page starts `?cursor=`. */
const NEWEST_PAGE = `${BASE}?limit=`;
const ME = "me@h";
const BOB = "bob@h";

function message(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    author: BOB,
    type: "message",
    content: { mime: "text/plain", text: id },
    createdAt: "2026-06-05T00:00:00Z",
    ...over,
  } as Message;
}

const page = (items: Message[], nextCursor: string | null = null) => ({
  items,
  page: { nextCursor },
});

/** A deferred GET, so a test can deliver events while a request is in flight. */
interface Pending {
  path: string;
  /** The request's abort signal, if it was given one. */
  signal?: AbortSignal;
  resolve(data: unknown): void;
}

/**
 * A scripted `OfscpClient`: a GET whose path starts with a `routes` key is
 * answered at once (reactions answer empty); any other GET waits in `pending`.
 */
function fakeClient(routes: Record<string, unknown>) {
  const pending: Pending[] = [];
  const client = {
    async get(path: string, opts?: { signal?: AbortSignal }) {
      if (path.endsWith("/reactions")) return { data: { items: [] } };
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (key !== undefined) return { data: routes[key] };
      return new Promise((resolve) => {
        pending.push({
          path,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          resolve: (data) => resolve({ data }),
        });
      });
    },
  } as unknown as OfscpClient;
  return { client, pending };
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
  const emit = (type: string, data: Record<string, unknown>, correlationId?: string): void => {
    for (const cb of listeners.get(type) ?? []) {
      cb({
        type,
        ts: "2026-06-05T00:00:00Z",
        data,
        ...(correlationId !== undefined ? { correlationId } : {}),
      } as WsEnvelope);
    }
  };
  return { ws, emit };
}

/** Opaque cursors: the client passes them through, never decodes them. */
const cur = (n: number) => `cur_${n}`;

const created = (m: Message, cursor?: string) => ({
  channelId: CH,
  message: m,
  ...(cursor !== undefined ? { cursor } : {}),
});

/** Let queued microtasks (resolved fetches and the folds after them) run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  clearChat();
  clearDms();
  clearTimelineHeads();
});
afterEach(() => clearTimelineHeads());

describe("channel timeline head", () => {
  test("replies loaded from outside the window land last in the list but never move the head", async () => {
    const article = message("m_article", { type: "article" });
    const { client } = fakeClient({
      [`${BASE}/m_article/replies`]: page([
        message("r_old1", { reference: { type: "reply", id: "m_article" } }),
        message("r_old2", { reference: { type: "reply", id: "m_article" } }),
      ]),
      [NEWEST_PAGE]: page([message("m_3"), message("m_2"), article]),
    });
    const { ws } = fakeWs();
    const handle = await openChannel({ client, ws, groupId: G, channelId: CH });
    expect(timelineHeadFor(CH)).toBe("m_3");

    await loadReplies({ client, groupId: G, channelId: CH, messageId: "m_article" });
    // The store appends the listing's replies: position no longer says "newest".
    expect(messagesFor(CH).map((m) => m.id)).toEqual([
      "m_article",
      "m_2",
      "m_3",
      "r_old1",
      "r_old2",
    ]);
    expect(timelineHeadFor(CH)).toBe("m_3");
    handle.close();
  });

  test("a live create committed after the page was read stays the head", async () => {
    const { client, pending } = fakeClient({});
    const { ws, emit } = fakeWs();
    const opening = openChannel({ client, ws, groupId: G, channelId: CH });
    await settle();
    emit("message.created", created(message("m_live"), cur(11)));
    expect(timelineHeadFor(CH)).toBe("m_live");

    pending.shift()?.resolve(page([message("m_10"), message("m_9")]));
    const handle = await opening;
    // The live create was pushed before the page: the list's last entry is m_10.
    expect(messagesFor(CH).at(-1)?.id).toBe("m_10");
    expect(timelineHeadFor(CH)).toBe("m_live");
    handle.close();
  });

  test("a live create the page also holds yields to the page's newest", async () => {
    const { client, pending } = fakeClient({});
    const { ws, emit } = fakeWs();
    const opening = openChannel({ client, ws, groupId: G, channelId: CH });
    await settle();
    emit("message.created", created(message("m_9"), cur(9)));
    pending.shift()?.resolve(page([message("m_10"), message("m_9")]));
    const handle = await opening;
    expect(timelineHeadFor(CH)).toBe("m_10");
    handle.close();
  });

  test("live creates move the head; edits, older pages and duplicate answers do not", async () => {
    const { client, pending } = fakeClient({
      [NEWEST_PAGE]: page([message("m_2"), message("m_1")], "older_1"),
    });
    const { ws, emit } = fakeWs();
    const handle = await openChannel({ client, ws, groupId: G, channelId: CH });

    emit("message.created", created(message("m_3"), cur(3)));
    expect(timelineHeadFor(CH)).toBe("m_3");

    // An edit to a message outside the window, then an older page.
    emit("message.updated", {
      channelId: CH,
      message: message("m_0", { editedAt: "2026-06-05T00:01:00Z" }),
      cursor: cur(0),
    });
    const older = handle.loadOlder();
    await settle();
    pending.shift()?.resolve(page([message("m_old")]));
    await older;
    expect(timelineHeadFor(CH)).toBe("m_3");

    // A duplicate-create answer (§7.1: correlated, no cursor) is an old message.
    emit("message.created", created(message("m_dup", { author: ME })), "frame_1");
    expect(timelineHeadFor(CH)).toBe("m_3");
    // The author's own fresh create is correlated and carries a cursor.
    emit("message.created", created(message("m_4", { author: ME }), cur(4)), "frame_2");
    expect(timelineHeadFor(CH)).toBe("m_4");

    handle.close();
    expect(timelineHeadFor(CH)).toBeUndefined();
  });

  test("reopening starts over: the last open's head is not reused", async () => {
    const first = fakeClient({ [NEWEST_PAGE]: page([message("m_5")]) });
    const { ws } = fakeWs();
    (await openChannel({ client: first.client, ws, groupId: G, channelId: CH })).close();

    const second = fakeClient({});
    const opening = openChannel({ client: second.client, ws, groupId: G, channelId: CH });
    await settle();
    expect(timelineHeadFor(CH)).toBeUndefined();
    second.pending.shift()?.resolve(page([message("m_6"), message("m_5")]));
    const handle = await opening;
    expect(timelineHeadFor(CH)).toBe("m_6");
    handle.close();
  });
});

describe("DM timeline head (received messages only)", () => {
  const dmEvent = (m: Message) => ({ dmId: DM, message: m, cursor: cur(1) });

  async function open(items: Message[]) {
    const { client } = fakeClient({ [`/api/dms/${DM}/messages`]: page(items) });
    const { ws, emit } = fakeWs();
    const handle = await openConversation({
      client,
      ws,
      dmId: DM,
      me: ME,
      counterparty: BOB,
      sentStore: new DmSentStore(ME, memBackend()),
    });
    return { handle, emit };
  }

  test("the newest received message of the newest inbox page is the head", async () => {
    const { handle } = await open([
      message("d_own", { author: ME, createdAt: "2026-06-05T00:00:03Z" }),
      message("d_2", { createdAt: "2026-06-05T00:00:02Z" }),
      message("d_1", { createdAt: "2026-06-05T00:00:01Z" }),
    ]);
    expect(timelineHeadFor(DM)).toBe("d_2");
    handle.close();
    expect(timelineHeadFor(DM)).toBeUndefined();
  });

  test("a newly delivered received message moves it; replacements and own messages do not", async () => {
    const { handle, emit } = await open([message("d_1", { createdAt: "2026-06-05T00:00:01Z" })]);

    emit("dm.message", dmEvent(message("d_2", { createdAt: "2026-06-05T00:00:02Z" })));
    expect(timelineHeadFor(DM)).toBe("d_2");

    // §7.4: a `dm.message` for a held id is a replacement (an edit) of it.
    emit("dm.message", dmEvent(message("d_1", { editedAt: "2026-06-05T00:00:05Z" })));
    // An edit or delete of a message outside the window.
    emit("dm.message", dmEvent(message("d_0", { editedAt: "2026-06-05T00:00:06Z" })));
    emit("dm.message", dmEvent(message("d_00", { deletedAt: "2026-06-05T00:00:07Z" })));
    // Our own message.
    emit("dm.message", dmEvent(message("d_mine", { author: ME })));
    expect(timelineHeadFor(DM)).toBe("d_2");
    expect(dmThread(DM).some((m) => m.id === "d_0")).toBe(true);
    handle.close();
  });

  test("a message created and edited while offline moves the head; an edit of an older one does not", async () => {
    const { handle, emit } = await open([message("d_1", { createdAt: "2026-06-05T00:00:01Z" })]);
    // A resume replays current state: d_2 arrives already edited.
    emit(
      "dm.message",
      dmEvent(
        message("d_2", { createdAt: "2026-06-05T00:00:02Z", editedAt: "2026-06-05T00:00:09Z" }),
      ),
    );
    expect(timelineHeadFor(DM)).toBe("d_2");
    // An edit of a message older than the head, outside the window.
    emit(
      "dm.message",
      dmEvent(
        message("d_0", { createdAt: "2026-06-05T00:00:00Z", editedAt: "2026-06-05T00:00:10Z" }),
      ),
    );
    expect(timelineHeadFor(DM)).toBe("d_2");
    handle.close();
  });

  test("edited deliveries that beat the first inbox page are judged against it", async () => {
    const { client, pending } = fakeClient({});
    const { ws, emit } = fakeWs();
    const opening = openConversation({
      client,
      ws,
      dmId: DM,
      me: ME,
      counterparty: BOB,
      sentStore: new DmSentStore(ME, memBackend()),
    });
    await settle();
    emit(
      "dm.message",
      dmEvent(
        message("d_3", { createdAt: "2026-06-05T00:00:03Z", editedAt: "2026-06-05T00:00:08Z" }),
      ),
    );
    emit(
      "dm.message",
      dmEvent(
        message("d_old", { createdAt: "2026-06-05T00:00:00Z", editedAt: "2026-06-05T00:00:09Z" }),
      ),
    );
    pending.shift()?.resolve(page([message("d_1", { createdAt: "2026-06-05T00:00:01Z" })]));
    const handle = await opening;
    expect(timelineHeadFor(DM)).toBe("d_3");
    handle.close();
  });

  test("A -> B -> A while A's first open is loading: the cancelled open leaves the new one alone", async () => {
    const DM_B = "dm_other";
    const { client, pending } = fakeClient({});
    const { ws, emit } = fakeWs();
    const sentStore = new DmSentStore(ME, memBackend());
    const deps = { client, ws, me: ME, counterparty: BOB, sentStore };
    const outcomes: string[] = [];
    const events = (name: string) => ({
      opened: () => outcomes.push(name),
      failed: (msg: string) => outcomes.push(`${name} failed: ${msg}`),
    });

    const firstA = startDmSession({ ...deps, dmId: DM }, events("A1"));
    await settle();
    firstA.dispose();
    startDmSession({ ...deps, dmId: DM_B }, events("B")).dispose();
    const secondA = startDmSession({ ...deps, dmId: DM }, events("A2"));
    await settle();

    const [stalePage, , freshPage] = pending;
    expect(stalePage?.path.startsWith(`/api/dms/${DM}/`)).toBe(true);
    expect(stalePage?.signal?.aborted).toBe(true);
    expect(freshPage?.path.startsWith(`/api/dms/${DM}/`)).toBe(true);
    expect(freshPage?.signal?.aborted).toBe(false);

    freshPage?.resolve(page([message("d_2", { createdAt: "2026-06-05T00:00:02Z" })]));
    await settle();
    expect(timelineHeadFor(DM)).toBe("d_2");

    // The cancelled open's page lands last: nothing of it is written.
    stalePage?.resolve(page([message("d_stale", { createdAt: "2026-06-05T00:00:03Z" })]));
    await settle();
    expect(timelineHeadFor(DM)).toBe("d_2");
    expect(dmThread(DM).some((m) => m.id === "d_stale")).toBe(false);
    expect(outcomes).toEqual(["A2"]);

    // Only the live open still listens, and disposing it ends it.
    emit("dm.message", dmEvent(message("d_4", { createdAt: "2026-06-05T00:00:04Z" })));
    expect(timelineHeadFor(DM)).toBe("d_4");
    secondA.dispose();
    expect(timelineHeadFor(DM)).toBeUndefined();
  });
});
