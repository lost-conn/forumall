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
import {
  DM_HISTORY_PAGE_SIZE,
  DmUnconfirmedError,
  deleteDm,
  editDm,
  sentWindow,
} from "../src/components/dms/dm-controller.ts";
import { DmSentStore, type SentDmMessage } from "../src/lib/dm-store.ts";
import { OfscpClient } from "../src/lib/ofscp-client.ts";
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
  restoreDmMessage,
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
    ...(over.editedAt !== undefined ? { editedAt: over.editedAt } : {}),
    ...(over.deletedAt !== undefined ? { deletedAt: over.deletedAt } : {}),
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

/**
 * §4.4.2 timestamps are SECOND-precision, so a burst of messages inside one
 * second all share a `createdAt`. Breaking that tie on the random `id` rendered
 * the burst in effectively random order; the tie-break is now the decoded cursor
 * `seq` — the provider's real timeline position — with `id` used only for rows
 * that carry no cursor at all (local sent copies / un-confirmed echoes, §8.3).
 */
describe("DM store: same-second ordering", () => {
  beforeEach(() => clearDms());

  /** Encode a cursor exactly as the server does: base64url of `{"seq":N}`. */
  const cur = (seq: number): string =>
    btoa(JSON.stringify({ seq })).replace(/\+/g, "-").replace(/\//g, "_");

  const T = "2026-06-05T00:00:00Z";
  const msg = (id: string, over: Partial<DmMessage> = {}): DmMessage => ({
    id,
    author: "bob@h",
    content: { text: id },
    createdAt: T,
    ...over,
  });

  test("a same-second burst orders by seq, not by id", () => {
    // Ids are chosen so alphabetical order is the REVERSE of the seq order —
    // exactly the shuffle the old comparator produced.
    upsertDmMessage(DM, msg("msg_c", { cursor: cur(9) }));
    upsertDmMessage(DM, msg("msg_a", { cursor: cur(1000) }));
    upsertDmMessage(DM, msg("msg_b", { cursor: cur(100) }));
    expect(dmThread(DM).map((m) => m.id)).toEqual(["msg_c", "msg_b", "msg_a"]);
  });

  test("createdAt still wins over seq (a later second sorts later)", () => {
    upsertDmMessage(DM, msg("msg_late", { createdAt: "2026-06-05T00:00:01Z", cursor: cur(1) }));
    upsertDmMessage(DM, msg("msg_early", { cursor: cur(999) }));
    expect(dmThread(DM).map((m) => m.id)).toEqual(["msg_early", "msg_late"]);
  });

  test("cursored messages precede cursorless ones within the same second", () => {
    // The caller's own retained/optimistic copies have no server cursor.
    upsertDmMessage(DM, msg("msg_aaa", { author: "alice@h", mine: true }));
    upsertDmMessage(DM, msg("msg_zzz", { cursor: cur(7) }));
    expect(dmThread(DM).map((m) => m.id)).toEqual(["msg_zzz", "msg_aaa"]);
  });

  test("two cursorless messages in the same second fall back to id", () => {
    upsertDmMessage(DM, msg("msg_b", { mine: true }));
    upsertDmMessage(DM, msg("msg_a", { mine: true }));
    expect(dmThread(DM).map((m) => m.id)).toEqual(["msg_a", "msg_b"]);
  });

  test("re-sorting on every upsert is stable (the order never thrashes)", () => {
    const seeded = [
      msg("msg_c", { cursor: cur(9) }),
      msg("msg_a", { cursor: cur(1000) }),
      msg("msg_d"),
      msg("msg_b", { cursor: cur(100) }),
    ];
    for (const m of seeded) upsertDmMessage(DM, m);
    const order = dmThread(DM).map((m) => m.id);
    // Re-upserting every message (an edit re-fan, a history overlap) must not
    // move anything: the comparator has to be a consistent total order.
    for (const m of seeded) upsertDmMessage(DM, m);
    expect(dmThread(DM).map((m) => m.id)).toEqual(order);
    expect(order).toEqual(["msg_c", "msg_b", "msg_a", "msg_d"]);
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

/**
 * Reverting an optimistic edit/delete must genuinely UN-edit: both stores merge
 * on their normal write path (`{...existing, ...incoming}`), so writing the old
 * content back cannot clear `editedAt`/`deletedAt` — the message would render
 * "(edited)" (or stay a tombstone) with its pre-edit text. The dedicated restore
 * paths exist for exactly that.
 */
describe("un-edit: reverting an optimistic edit/delete clears its markers", () => {
  beforeEach(() => clearDms());

  const original: DmMessage = {
    id: "m1",
    author: "me@h",
    content: { mime: "text/plain", text: "original" },
    createdAt: "2026-06-05T00:00:00Z",
    mine: true,
  };

  test("thread store: an edit then a restore leaves NO editedAt and the original content", () => {
    upsertDmMessage(DM, original);
    applyDmEdit(DM, {
      ...original,
      content: { mime: "text/plain", text: "edited" },
      editedAt: "2026-06-05T00:01:00Z",
    });
    expect(dmThread(DM)[0]?.editedAt).toBe("2026-06-05T00:01:00Z");

    restoreDmMessage(DM, { id: "m1", content: { mime: "text/plain", text: "original" } });
    const m = dmThread(DM)[0];
    expect(m?.content.text).toBe("original");
    expect(m?.editedAt).toBeUndefined();
    // Not merely `undefined`-valued: the key is gone, so nothing can re-surface it.
    expect(Object.hasOwn(m as object, "editedAt")).toBe(false);
    // Identity + placement survive the revert.
    expect(m?.author).toBe("me@h");
    expect(m?.mine).toBe(true);
  });

  test("thread store: a restore rewinds to a PRIOR editedAt when the message had one", () => {
    upsertDmMessage(DM, { ...original, editedAt: "2026-06-05T00:00:30Z" });
    applyDmEdit(DM, {
      ...original,
      content: { mime: "text/plain", text: "edited twice" },
      editedAt: "2026-06-05T00:01:00Z",
    });
    restoreDmMessage(DM, {
      id: "m1",
      content: { mime: "text/plain", text: "original" },
      editedAt: "2026-06-05T00:00:30Z",
    });
    expect(dmThread(DM)[0]?.editedAt).toBe("2026-06-05T00:00:30Z");
  });

  test("thread store: a restore un-tombstones (clears deletedAt + content)", () => {
    upsertDmMessage(DM, original);
    tombstoneDmMessage(DM, "m1", "2026-06-05T00:02:00Z");
    expect(dmThread(DM)[0]?.deletedAt).toBe("2026-06-05T00:02:00Z");

    restoreDmMessage(DM, { id: "m1", content: { mime: "text/plain", text: "original" } });
    const m = dmThread(DM)[0];
    expect(m?.deletedAt).toBeUndefined();
    expect(Object.hasOwn(m as object, "deletedAt")).toBe(false);
    expect(m?.content.text).toBe("original");
  });

  test("thread store: restoring an unloaded message is a no-op", () => {
    restoreDmMessage(DM, { id: "nope", content: { text: "x" } });
    expect(dmThread(DM)).toHaveLength(0);
  });

  test("sent-store: restore clears editedAt/deletedAt that append() would have kept", () => {
    const store = new DmSentStore("me@h", memBackend());
    store.append(DM, sent({ id: "m1", content: { text: "original" }, clientMessageId: "c1" }));
    store.append(
      DM,
      sent({ id: "m1", content: { text: "edited" }, editedAt: "2026-06-05T00:01:00Z" }),
    );
    expect(store.list(DM)[0]?.editedAt).toBe("2026-06-05T00:01:00Z");

    // The old (merging) revert: the content rewinds but the marker sticks.
    store.append(DM, sent({ id: "m1", content: { text: "original" } }));
    expect(store.list(DM)[0]?.editedAt).toBe("2026-06-05T00:01:00Z");

    // The restore path replaces wholesale, so the marker is actually gone.
    store.restore(DM, sent({ id: "m1", content: { text: "original" }, clientMessageId: "c1" }));
    const m = store.list(DM)[0];
    expect(m?.content.text).toBe("original");
    expect(m?.editedAt).toBeUndefined();
    expect(m?.deletedAt).toBeUndefined();
    // Echo linkage the caller passed through is preserved.
    expect(m?.clientMessageId).toBe("c1");
    expect(store.list(DM)).toHaveLength(1);
  });

  test("sent-store: restore inserts when no entry exists (second device)", () => {
    const store = new DmSentStore("me@h", memBackend());
    store.restore(DM, sent({ id: "m1", content: { text: "original" } }));
    expect(store.list(DM).map((m) => m.id)).toEqual(["m1"]);
  });
});

/**
 * Defect (A): the revert used to fire on ANY rejection. Only a DEFINITIVE 4xx
 * proves the provider refused; an aborted fetch / network drop / 5xx leaves the
 * outcome unknown, and since §8.3 keeps no sender copy to re-sync from, a wrong
 * revert diverges the author's retained copy from the recipient's stored copy
 * permanently. So the optimistic state is KEPT and a `DmUnconfirmedError` is
 * raised for the UI to distinguish.
 */
describe("editDm / deleteDm: revert only on a definitive rejection", () => {
  beforeEach(() => clearDms());

  /** A client whose transport always fails the given way. */
  const failingClient = (fail: () => Promise<Response>): OfscpClient =>
    new OfscpClient({ baseUrl: "https://h", fetch: (() => fail()) as unknown as typeof fetch });

  const rejects = (status: number) => () =>
    Promise.resolve(
      new Response(JSON.stringify({ detail: "no" }), {
        status,
        headers: { "content-type": "application/problem+json" },
      }),
    );
  const drops = () => Promise.reject(new TypeError("Failed to fetch"));
  const aborts = () => Promise.reject(new DOMException("aborted", "AbortError"));

  /** Seed the thread + sent-store with one of the caller's own messages. */
  const seed = (): DmSentStore => {
    const store = new DmSentStore("me@h", memBackend());
    upsertDmMessage(DM, {
      id: "m1",
      author: "me@h",
      content: { mime: "text/plain", text: "original" },
      createdAt: "2026-06-05T00:00:00Z",
      mine: true,
    });
    store.append(
      DM,
      sent({ id: "m1", author: "me@h", content: { mime: "text/plain", text: "original" } }),
    );
    return store;
  };
  const message = {
    id: "m1",
    author: "me@h",
    content: { mime: "text/plain", text: "original" },
    createdAt: "2026-06-05T00:00:00Z",
  };

  test("a 403 edit reverts BOTH stores back to the original, un-edited", async () => {
    const sentStore = seed();
    await expect(
      editDm({
        client: failingClient(rejects(403)),
        dmId: DM,
        message,
        me: "me@h",
        text: "nope",
        sentStore,
      }),
    ).rejects.toThrow(/403/);

    const inThread = dmThread(DM)[0];
    expect(inThread?.content.text).toBe("original");
    expect(inThread?.editedAt).toBeUndefined();
    const retained = sentStore.list(DM)[0];
    expect(retained?.content.text).toBe("original");
    expect(retained?.editedAt).toBeUndefined();
  });

  for (const [label, fail] of [
    ["an aborted fetch", aborts],
    ["a network drop", drops],
    ["a 5xx", rejects(500)],
  ] as const) {
    test(`${label} KEEPS the optimistic edit and throws DmUnconfirmedError`, async () => {
      const sentStore = seed();
      const err = await editDm({
        client: failingClient(fail),
        dmId: DM,
        message,
        me: "me@h",
        text: "kept",
        sentStore,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DmUnconfirmedError);
      expect((err as DmUnconfirmedError).cause).toBeDefined();
      expect(dmThread(DM)[0]?.content.text).toBe("kept");
      expect(dmThread(DM)[0]?.editedAt).toBeDefined();
      expect(sentStore.list(DM)[0]?.content.text).toBe("kept");
    });

    test(`${label} KEEPS the optimistic tombstone and throws DmUnconfirmedError`, async () => {
      const sentStore = seed();
      const err = await deleteDm({
        client: failingClient(fail),
        dmId: DM,
        message,
        me: "me@h",
        sentStore,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DmUnconfirmedError);
      expect(dmThread(DM)[0]?.deletedAt).toBeDefined();
      expect(sentStore.list(DM)[0]?.deletedAt).toBeDefined();
    });
  }

  test("a 403 delete un-tombstones BOTH stores", async () => {
    const sentStore = seed();
    await expect(
      deleteDm({ client: failingClient(rejects(403)), dmId: DM, message, me: "me@h", sentStore }),
    ).rejects.toThrow(/403/);

    expect(dmThread(DM)[0]?.deletedAt).toBeUndefined();
    expect(dmThread(DM)[0]?.content.text).toBe("original");
    expect(sentStore.list(DM)[0]?.deletedAt).toBeUndefined();
    expect(sentStore.list(DM)[0]?.content.text).toBe("original");
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
