/**
 * The sent store follows the server's copies of the caller's own DM messages
 * (`dm-sent-copies.ts`), so a reload shows the server's latest version: a live
 * `dm.message` (an edit's confirmation, another device's edit or delete) and a
 * history page reach it through the real DM controller. While a mutation of the
 * message is unsettled the entry keeps the user's latest edit, and an edit still
 * pending after an earlier one was confirmed is re-based on it, so a reload
 * mid-chain keeps the newer edit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message, WsEnvelope } from "@forumall/shared";
import { openConversation } from "../src/components/dms/dm-controller.ts";
import { editDm } from "../src/components/dms/dm-mutations.ts";
import { DmSentStore } from "../src/lib/dm-store.ts";
import type { OfscpClient } from "../src/lib/ofscp-client.ts";
import type { OfscpWsClient } from "../src/lib/ofscp-ws.ts";
import { clearDms, upsertDmMessage } from "../src/stores/dms.ts";
import { clearTimelineHeads } from "../src/stores/timeline-heads.ts";
import { DM, memBackend, sent } from "./helpers/dm-fixtures.ts";
import {
  CREATED,
  E1,
  E2,
  E3,
  ME,
  echo,
  heldClient,
  retained,
  shown,
  stored,
  until,
} from "./helpers/dm-held.ts";

const BOB = "bob@h.example";

/** `m1` as a §5.3 message at a version. */
function copy(over: Partial<Message> = {}): Message {
  return { ...stored("original"), ...over } as Message;
}

/** A client answering the history GET with `items`. */
function historyClient(items: Message[]): OfscpClient {
  return {
    async get(path: string) {
      if (path.startsWith(`/api/dms/${DM}/messages`)) {
        return { data: { items, page: { nextCursor: null } } };
      }
      return { data: { items: [] } };
    },
  } as unknown as OfscpClient;
}

/** A WS stand-in that delivers `dm.message` events to the controller. */
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
  const dmMessage = (message: Message): void => {
    for (const cb of listeners.get("dm.message") ?? []) {
      cb({ type: "dm.message", ts: CREATED, data: { dmId: DM, message } } as WsEnvelope);
    }
  };
  return { ws, dmMessage };
}

let sentStore: DmSentStore;

beforeEach(() => {
  clearDms();
  clearTimelineHeads();
  sentStore = new DmSentStore(ME, memBackend());
  sentStore.append(DM, sent({ id: "m1", author: ME, content: { text: "original" } }));
  // `sent()` fixes its own createdAt; align it with the server copies.
  sentStore.restore(DM, { ...retained(sentStore), createdAt: CREATED });
});
afterEach(() => clearTimelineHeads());

async function open(history: Message[] = []) {
  const { ws, dmMessage } = fakeWs();
  const handle = await openConversation({
    client: historyClient(history),
    ws,
    dmId: DM,
    me: ME,
    counterparty: BOB,
    sentStore,
  });
  return { handle, dmMessage };
}

describe("server copies of the caller's own messages reach the sent store", () => {
  test("a live edit from another device is retained", async () => {
    const { handle, dmMessage } = await open();
    dmMessage(copy({ content: { mime: "text/markdown", text: "from my phone" }, editedAt: E3 }));
    expect(retained(sentStore).content.text).toBe("from my phone");
    expect(retained(sentStore).editedAt).toBe(E3);
    handle.close();
  });

  test("a live delete from another device is retained as a tombstone", async () => {
    const { handle, dmMessage } = await open();
    dmMessage(copy({ content: { mime: "text/plain", text: "" }, deletedAt: E3 }));
    expect(retained(sentStore).deletedAt).toBe(E3);
    expect(retained(sentStore).content.text).toBe("");
    handle.close();
  });

  test("a self/same-node history page's newer copy is retained; an older one changes nothing", async () => {
    const { handle } = await open([
      copy({ content: { mime: "text/markdown", text: "edited" }, editedAt: E1 }),
    ]);
    expect(retained(sentStore).content.text).toBe("edited");
    handle.close();

    const again = await open([copy()]);
    expect(retained(sentStore).content.text).toBe("edited");
    again.handle.close();
  });

  test("another author's message is not retained", async () => {
    const { handle, dmMessage } = await open();
    dmMessage(copy({ id: "m2", author: BOB, editedAt: E3 }));
    expect(sentStore.list(DM).map((m) => m.id)).toEqual(["m1"]);
    handle.close();
  });

  test("while an edit is unsettled the entry keeps it; the settle installs the winner", async () => {
    const { handle, dmMessage } = await open();
    const { client, requests } = heldClient();
    const pending = editDm({ client, dmId: DM, message: shown(), me: ME, text: "mine", sentStore });
    await until(() => requests.length === 1);

    dmMessage(copy({ content: { mime: "text/markdown", text: "from my phone" }, editedAt: E3 }));
    expect(retained(sentStore).content.text).toBe("mine");

    requests[0]?.answer(200, stored("mine", E1));
    await pending;
    expect(retained(sentStore).content.text).toBe("from my phone");
    expect(retained(sentStore).editedAt).toBe(E3);
    handle.close();
  });
});

describe("a reload mid-chain keeps the newer edit", () => {
  test("the pending second edit is re-based on the confirmed first", async () => {
    const { client, requests } = heldClient();
    upsertDmMessage(DM, {
      id: "m1",
      author: ME,
      content: { mime: "text/markdown", text: "original" },
      createdAt: CREATED,
      mine: true,
    });
    const first = editDm({ client, dmId: DM, message: shown(), me: ME, text: "one", sentStore });
    const second = editDm({ client, dmId: DM, message: shown(), me: ME, text: "two", sentStore });
    await until(() => requests.length === 1);
    requests[0]?.answer(200, stored("one", E1));
    await first;
    await until(() => requests.length === 2);

    // What a reload would hydrate: the second edit, based on the first's version.
    const persisted = retained(sentStore);
    expect(persisted.content.text).toBe("two");
    expect(persisted.localVersion).toEqual({ basedOn: E1 });

    // A fresh thread from it: the first edit's server copy cannot replace it…
    clearDms();
    upsertDmMessage(DM, { ...persisted, mine: true });
    upsertDmMessage(DM, echo("one", E1));
    expect(shown().content.text).toBe("two");
    // …while the second edit's own copy does.
    upsertDmMessage(DM, echo("two", E2));
    expect(shown().editedAt).toBe(E2);
    expect(shown().localVersion).toBeUndefined();

    requests[1]?.answer(200, stored("two", E2));
    await second;
  });
});
