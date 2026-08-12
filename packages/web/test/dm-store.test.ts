/**
 * DM local sent-store + DM store unit tests (P8 DMs UI).
 *
 * Covers the §8.3 invariants the DM thread relies on:
 *  - the local sent-store persists/lists per-user sent messages, de-duped by id +
 *    clientMessageId, and remembers a counterparty for only-sent conversations;
 *  - the DM store merges received + sent into one ordered timeline, de-duped by
 *    id, with optimistic-echo reconciliation in place.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Reaction } from "@forumall/shared";
import { DM_HISTORY_PAGE_SIZE, sentWindow } from "../src/components/dms/dm-controller.ts";
import { DmSentStore, type SentDmMessage } from "../src/lib/dm-store.ts";
import {
  type DmMessage,
  addDmOptimistic,
  addDmReactionAgg,
  applyDmEdit,
  clearDms,
  dmConversations,
  dmHasOlder,
  dmOlderCursorFor,
  dmReactionsFor,
  dmThread,
  dmTypingFor,
  removeDmReactionAgg,
  setDmOlderCursor,
  setDmTyping,
  tombstoneDmMessage,
  upsertConversation,
  upsertDmMessage,
} from "../src/stores/dms.ts";

function reaction(over: Partial<Reaction>): Reaction {
  return {
    id: over.id ?? "rct_1",
    author: over.author ?? "alice@h",
    key: over.key ?? "+1",
    reference: over.reference ?? { type: "message", id: "m1" },
    createdAt: "2026-06-05T00:00:00Z",
    metadata: [],
    ...(over.unicode !== undefined ? { unicode: over.unicode } : {}),
  } as Reaction;
}

const DM = "dm_aaaa";

/** A fresh in-memory backend so each test is isolated from localStorage. */
function memBackend() {
  const map = new Map<string, string>();
  return {
    read: (k: string) => map.get(k) ?? null,
    write: (k: string, v: string) => {
      map.set(k, v);
    },
    remove: (k: string) => {
      map.delete(k);
    },
    keys: () => [...map.keys()],
  };
}

function sent(over: Partial<SentDmMessage>): SentDmMessage {
  return {
    id: over.id ?? "msg_1",
    author: over.author ?? "alice@h",
    content: over.content ?? { mime: "text/plain", text: "hi" },
    createdAt: over.createdAt ?? "2026-06-05T00:00:00.000Z",
    ...(over.clientMessageId !== undefined ? { clientMessageId: over.clientMessageId } : {}),
  };
}

describe("DmSentStore", () => {
  test("persists + lists sent messages per user, sorted by createdAt", () => {
    const store = new DmSentStore("alice@h", memBackend());
    store.append(DM, sent({ id: "msg_2", createdAt: "2026-06-05T00:00:02.000Z" }));
    store.append(DM, sent({ id: "msg_1", createdAt: "2026-06-05T00:00:01.000Z" }));
    const list = store.list(DM);
    expect(list.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
  });

  test("de-dupes by id (idempotent re-append replaces in place)", () => {
    const store = new DmSentStore("alice@h", memBackend());
    store.append(DM, sent({ id: "msg_1", content: { text: "v1" } }));
    store.append(DM, sent({ id: "msg_1", content: { text: "v2" } }));
    const list = store.list(DM);
    expect(list).toHaveLength(1);
    expect(list[0]?.content.text).toBe("v2");
  });

  test("de-dupes by clientMessageId across an optimistic→canonical collapse", () => {
    const store = new DmSentStore("alice@h", memBackend());
    store.append(DM, sent({ id: "optimistic:c1", clientMessageId: "c1" }));
    store.append(DM, sent({ id: "msg_real", clientMessageId: "c1" }));
    const list = store.list(DM);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("msg_real");
  });

  test("knownDmIds + counterparty memory for only-sent conversations", () => {
    const store = new DmSentStore("alice@h", memBackend());
    store.append(DM, sent({}));
    store.rememberCounterparty(DM, "bob@h");
    expect(store.knownDmIds()).toEqual([DM]);
    expect(store.counterpartyFor(DM)).toBe("bob@h");
  });

  test("is scoped per user (two accounts don't bleed)", () => {
    const backend = memBackend();
    const alice = new DmSentStore("alice@h", backend);
    const bob = new DmSentStore("bob@h", backend);
    alice.append(DM, sent({ id: "msg_a" }));
    expect(bob.list(DM)).toHaveLength(0);
    expect(alice.list(DM)).toHaveLength(1);
  });

  test("clear wipes only this user's entries + meta", () => {
    const store = new DmSentStore("alice@h", memBackend());
    store.append(DM, sent({}));
    store.rememberCounterparty(DM, "bob@h");
    store.clear();
    expect(store.list(DM)).toHaveLength(0);
    expect(store.knownDmIds()).toHaveLength(0);
    expect(store.counterpartyFor(DM)).toBeNull();
  });
});

describe("DM store: merge received + sent", () => {
  beforeEach(() => clearDms());

  test("interleaves received + sent by createdAt, de-duped by id", () => {
    const recv: DmMessage = {
      id: "msg_r1",
      author: "bob@h",
      content: { text: "hey" },
      createdAt: "2026-06-05T00:00:02.000Z",
    };
    const mine: DmMessage = {
      id: "msg_s1",
      author: "alice@h",
      content: { text: "hi" },
      createdAt: "2026-06-05T00:00:01.000Z",
      mine: true,
    };
    upsertDmMessage(DM, recv);
    upsertDmMessage(DM, mine);
    upsertDmMessage(DM, recv); // duplicate received → no-op
    const thread = dmThread(DM);
    expect(thread.map((m) => m.id)).toEqual(["msg_s1", "msg_r1"]);
  });

  test("optimistic echo reconciles in place to the canonical id", () => {
    addDmOptimistic(DM, {
      id: "optimistic:c1",
      author: "alice@h",
      content: { text: "hi" },
      createdAt: "2026-06-05T00:00:01.000Z",
      clientMessageId: "c1",
    });
    expect(dmThread(DM)[0]?.pending).toBe(true);
    upsertDmMessage(DM, {
      id: "msg_real",
      author: "alice@h",
      content: { text: "hi" },
      createdAt: "2026-06-05T00:00:01.000Z",
      clientMessageId: "c1",
      mine: true,
    });
    const thread = dmThread(DM);
    expect(thread).toHaveLength(1);
    expect(thread[0]?.id).toBe("msg_real");
    expect(thread[0]?.pending).toBe(false);
  });

  test("conversation list sorts by updatedAt desc", () => {
    upsertConversation({
      dmId: "dm_a",
      counterparty: "bob@h",
      updatedAt: "2026-06-05T00:00:01.000Z",
    });
    upsertConversation({
      dmId: "dm_b",
      counterparty: "carol@h",
      updatedAt: "2026-06-05T00:00:03.000Z",
    });
    expect(dmConversations().map((c) => c.dmId)).toEqual(["dm_b", "dm_a"]);
  });
});

describe("DM store: reactions (client-side aggregation)", () => {
  beforeEach(() => clearDms());

  test("counts + authors aggregate per key; removal decrements / clears", () => {
    addDmReactionAgg(DM, reaction({ author: "a@h", key: "+1", unicode: "👍" }));
    addDmReactionAgg(DM, reaction({ author: "b@h", key: "+1", unicode: "👍" }));
    addDmReactionAgg(DM, reaction({ author: "a@h", key: "heart", unicode: "❤️" }));

    let groups = dmReactionsFor(DM, "m1");
    const thumb = groups.find((g) => g.key === "+1");
    expect(thumb?.authors).toHaveLength(2);
    expect(thumb?.unicode).toBe("👍");

    removeDmReactionAgg(DM, "m1", "+1", "a@h");
    groups = dmReactionsFor(DM, "m1");
    expect(groups.find((g) => g.key === "+1")?.authors).toEqual(["b@h"]);

    removeDmReactionAgg(DM, "m1", "+1", "b@h");
    expect(dmReactionsFor(DM, "m1").find((g) => g.key === "+1")).toBeUndefined();
  });

  test("a repeated add by the same author is idempotent (own optimistic toggle)", () => {
    addDmReactionAgg(DM, reaction({ author: "me@h", key: "+1" }));
    addDmReactionAgg(DM, reaction({ author: "me@h", key: "+1" }));
    expect(dmReactionsFor(DM, "m1").find((g) => g.key === "+1")?.authors).toEqual(["me@h"]);
  });

  test("reactions are scoped per dmId", () => {
    addDmReactionAgg(DM, reaction({ author: "a@h", key: "+1" }));
    addDmReactionAgg("dm_other", reaction({ author: "a@h", key: "+1" }));
    expect(dmReactionsFor(DM, "m1")).toHaveLength(1);
    expect(dmReactionsFor("dm_other", "m1")).toHaveLength(1);
    removeDmReactionAgg(DM, "m1", "+1", "a@h");
    expect(dmReactionsFor(DM, "m1")).toHaveLength(0);
    expect(dmReactionsFor("dm_other", "m1")).toHaveLength(1);
  });
});

describe("DM store: edit + tombstone in place", () => {
  beforeEach(() => clearDms());

  test("an edit replaces content + sets editedAt in place (no duplicate)", () => {
    upsertDmMessage(DM, {
      id: "m1",
      author: "me@h",
      content: { text: "original" },
      createdAt: "2026-06-05T00:00:00Z",
      mine: true,
    });
    applyDmEdit(DM, {
      id: "m1",
      author: "me@h",
      content: { text: "edited" },
      createdAt: "2026-06-05T00:00:00Z",
      editedAt: "2026-06-05T00:01:00Z",
      mine: true,
    });
    const list = dmThread(DM);
    expect(list).toHaveLength(1);
    expect(list[0]?.content.text).toBe("edited");
    expect(list[0]?.editedAt).toBe("2026-06-05T00:01:00Z");
  });

  test("deleting clears content + attachments + sets deletedAt, keeps position", () => {
    upsertDmMessage(DM, {
      id: "m1",
      author: "me@h",
      content: { text: "one" },
      createdAt: "2026-06-05T00:00:00Z",
    });
    upsertDmMessage(DM, {
      id: "m2",
      author: "me@h",
      content: { text: "two" },
      createdAt: "2026-06-05T00:00:01Z",
    });
    tombstoneDmMessage(DM, "m1", "2026-06-05T00:02:00Z");
    const list = dmThread(DM);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe("m1");
    expect(list[0]?.deletedAt).toBe("2026-06-05T00:02:00Z");
    expect(list[0]?.content.text).toBe("");
    expect(list[0]?.attachments).toEqual([]);
  });
});

describe("DM store: attachments + reference on the message model", () => {
  beforeEach(() => clearDms());

  test("attachments + reference are carried on upsert", () => {
    upsertDmMessage(DM, {
      id: "m1",
      author: "me@h",
      content: { text: "see attached" },
      attachments: [
        {
          id: "att_1",
          url: "https://h/api/media/att_1",
          mime: "image/png",
          size: 10,
          metadata: [],
        },
      ],
      reference: { type: "reply", id: "parent" },
      createdAt: "2026-06-05T00:00:00Z",
      mine: true,
    });
    const m = dmThread(DM)[0];
    expect(m?.attachments).toHaveLength(1);
    expect(m?.reference?.id).toBe("parent");
  });
});

describe("DM store: older-history paging state", () => {
  beforeEach(() => clearDms());

  test("cursor + hasOlder round-trip and are cleared with the store", () => {
    expect(dmOlderCursorFor(DM)).toBeUndefined();
    expect(dmHasOlder(DM)).toBe(false);

    setDmOlderCursor(DM, "cursor_older", true);
    expect(dmOlderCursorFor(DM)).toBe("cursor_older");
    expect(dmHasOlder(DM)).toBe(true);

    // The inbox can be exhausted while local sent backlog remains — the two
    // signals are independent (that's why `hasOlder` isn't derived from the
    // cursor).
    setDmOlderCursor(DM, null, true);
    expect(dmOlderCursorFor(DM)).toBeNull();
    expect(dmHasOlder(DM)).toBe(true);

    setDmOlderCursor(DM, null, false);
    expect(dmHasOlder(DM)).toBe(false);

    setDmOlderCursor(DM, "c", true);
    clearDms();
    expect(dmOlderCursorFor(DM)).toBeUndefined();
    expect(dmHasOlder(DM)).toBe(false);
  });
});

describe("sent-store windowing (which sent messages belong in the window)", () => {
  /** `n` sent messages, ascending, one second apart from 00:00:00. */
  const log = (n: number): SentDmMessage[] =>
    Array.from({ length: n }, (_, i) =>
      sent({
        id: `msg_${String(i).padStart(3, "0")}`,
        createdAt: `2026-06-05T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );

  test("takes only the newest `limit` when there's no received floor", () => {
    const window = sentWindow(log(10), { limit: 3 });
    expect(window.map((m) => m.id)).toEqual(["msg_007", "msg_008", "msg_009"]);
  });

  test("an only-sent conversation (no inbox row) still renders its newest page", () => {
    const all = log(DM_HISTORY_PAGE_SIZE + 5);
    const window = sentWindow(all, { limit: DM_HISTORY_PAGE_SIZE });
    expect(window).toHaveLength(DM_HISTORY_PAGE_SIZE);
    expect(window[window.length - 1]?.id).toBe(all[all.length - 1]?.id);
    // …and paging back reveals the rest, one page at a time.
    expect(sentWindow(all, { limit: DM_HISTORY_PAGE_SIZE * 2 })).toHaveLength(all.length);
  });

  test("extends DOWN to the oldest loaded received message (no hole in the merge)", () => {
    // Received history reaches back to 00:00:02, so every sent message at or
    // after it must be hydrated even though `limit` alone would stop at 5.
    const window = sentWindow(log(10), { limit: 5, downTo: "2026-06-05T00:00:02.000Z" });
    expect(window.map((m) => m.id)).toEqual([
      "msg_002",
      "msg_003",
      "msg_004",
      "msg_005",
      "msg_006",
      "msg_007",
      "msg_008",
      "msg_009",
    ]);
  });

  test("the floor extension is capped at one extra page (second-precision bursts)", () => {
    // Every message shares one `createdAt` second (a burst): an uncapped floor
    // would hydrate the entire log, so the window stops at 2 × limit.
    const burst = Array.from({ length: 10 }, (_, i) =>
      sent({ id: `msg_${String(i).padStart(3, "0")}`, createdAt: "2026-06-05T00:00:00.000Z" }),
    );
    const window = sentWindow(burst, { limit: 2, downTo: "2026-06-05T00:00:00.000Z" });
    expect(window.map((m) => m.id)).toEqual(["msg_006", "msg_007", "msg_008", "msg_009"]);
  });

  test("a floor NEWER than the limit window never shrinks it", () => {
    const window = sentWindow(log(10), { limit: 5, downTo: "2026-06-05T00:00:09.000Z" });
    expect(window).toHaveLength(5);
  });

  test("a shorter log than the limit is fully hydrated", () => {
    expect(sentWindow(log(2), { limit: 50 })).toHaveLength(2);
    expect(sentWindow([], { limit: 50 })).toHaveLength(0);
  });
});

describe("DM store: typing", () => {
  beforeEach(() => clearDms());

  test("start adds, stop removes (idempotent)", () => {
    setDmTyping(DM, "a@h", true);
    expect(dmTypingFor(DM)).toEqual(["a@h"]);
    setDmTyping(DM, "a@h", true);
    expect(dmTypingFor(DM)).toEqual(["a@h"]);
    setDmTyping(DM, "a@h", false);
    expect(dmTypingFor(DM)).toEqual([]);
  });
});
