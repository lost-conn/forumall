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
import { DmSentStore, type SentDmMessage } from "../src/lib/dm-store.ts";
import {
  type DmMessage,
  addDmOptimistic,
  clearDms,
  dmConversations,
  dmThread,
  upsertConversation,
  upsertDmMessage,
} from "../src/stores/dms.ts";

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
