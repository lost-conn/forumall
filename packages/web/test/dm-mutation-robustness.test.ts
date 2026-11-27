/**
 * The DM edit/delete chain (`dm-mutation-chain.ts`, `dm-mutations.ts`) under
 * failure: a settle keeps the row's object (so the row that shows the error is
 * the one on screen), mutations take their place in the order when they are
 * called, every mutation settles whatever throws, and a hung request times out
 * as an unknown outcome instead of holding the message's later mutations.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { DmUnconfirmedError } from "../src/components/dms/dm-errors.ts";
import { deleteDm, editDm } from "../src/components/dms/dm-mutations.ts";
import { DmSentStore } from "../src/lib/dm-store.ts";
import { type OfscpClient, OfscpHttpError } from "../src/lib/ofscp-client.ts";
import { clearDms, tombstoneDmMessage, upsertDmMessage } from "../src/stores/dms.ts";
import { DM, memBackend, sent } from "./helpers/dm-fixtures.ts";
import {
  CREATED,
  E1,
  E3,
  type Held,
  ME,
  drain,
  heldClient,
  retained,
  shown,
  stored,
  until,
} from "./helpers/dm-held.ts";

/** A sent-store backend whose next write throws, once armed (a full `localStorage`). */
function quotaBackend() {
  const inner = memBackend();
  let failNext = false;
  return {
    arm: () => {
      failNext = true;
    },
    backend: {
      ...inner,
      write: (k: string, v: string) => {
        if (failNext) {
          failNext = false;
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        }
        inner.write(k, v);
      },
    },
  };
}

let sentStore: DmSentStore;
let quota: ReturnType<typeof quotaBackend>;
let client: OfscpClient;
let requests: Held[];

beforeEach(() => {
  clearDms();
  quota = quotaBackend();
  sentStore = new DmSentStore(ME, quota.backend);
  ({ client, requests } = heldClient());
  upsertDmMessage(DM, {
    id: "m1",
    author: ME,
    content: { mime: "text/markdown", text: "original" },
    createdAt: CREATED,
    mine: true,
  });
  sentStore.append(DM, sent({ id: "m1", author: ME, content: { text: "original" } }));
});

const edit = (text: string, extra: Partial<Parameters<typeof editDm>[0]> = {}) =>
  editDm({ client, dmId: DM, message: shown(), me: ME, text, sentStore, ...extra }).catch(
    (err: unknown) => err,
  );

describe("a settle keeps the row's object", () => {
  test("a rejected edit rewinds the same object, and its error follows the settle", async () => {
    const row = shown();
    const pending = edit("one");
    expect(shown()).toBe(row);
    await until(() => requests.length === 1);
    requests[0]?.answer(403, { detail: "edit window closed" });
    const err = await pending;

    expect(err).toBeInstanceOf(OfscpHttpError);
    // The very object `<For>` rendered: the row stays mounted to show the error.
    expect(shown()).toBe(row);
    expect(row.content.text).toBe("original");
    expect(row.editedAt).toBeUndefined();
    expect(row.localVersion).toBeUndefined();
  });

  test("an unconfirmed edit settles in place too", async () => {
    const row = shown();
    const pending = edit("one");
    await until(() => requests.length === 1);
    requests[0]?.answer(502, { detail: "bad gateway" });

    expect(await pending).toBeInstanceOf(DmUnconfirmedError);
    expect(shown()).toBe(row);
    expect(row.content.text).toBe("one");
    expect(row.localVersion).toEqual({});
  });

  test("a rejected delete un-tombstones the same object", async () => {
    const row = shown();
    const pending = deleteDm({ client, dmId: DM, message: shown(), me: ME, sentStore }).catch(
      (err: unknown) => err,
    );
    expect(row.deletedAt).toBeDefined();
    await until(() => requests.length === 1);
    requests[0]?.answer(403, { detail: "no" });

    expect(await pending).toBeInstanceOf(OfscpHttpError);
    expect(shown()).toBe(row);
    expect(row.deletedAt).toBeUndefined();
    expect(row.content.text).toBe("original");
  });
});

describe("a mutation takes its place in the order when it is called", () => {
  test("an edit whose delivery client resolves late still goes first", async () => {
    let resolveSlow: (c: null) => void = () => {};
    const slow = new Promise<null>((r) => {
      resolveSlow = r;
    });
    const first = edit("one", { deliveryClient: slow });
    const second = edit("two", { deliveryClient: Promise.resolve(null) });
    expect(shown().content.text).toBe("two");
    await drain();
    // The second waits for the first, whose client is still resolving.
    expect(requests).toHaveLength(0);

    resolveSlow(null);
    await until(() => requests.length === 1);
    expect(requests[0]?.body?.content?.text).toBe("one");
    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    expect(requests[1]?.body?.content?.text).toBe("two");
    requests[1]?.answer(200, stored("two", "2026-11-27T10:05:01Z"));
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(shown().content.text).toBe("two");
  });

  test("a delivery client that fails to resolve rejects the edit (never sent) and frees the next", async () => {
    const failed = edit("one", { deliveryClient: Promise.reject(new Error("no key")) });
    const next = edit("two");

    const err = await failed;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DmUnconfirmedError);
    await until(() => requests.length === 1);
    expect(requests[0]?.body?.content?.text).toBe("two");
    requests[0]?.answer(200, stored("two", E1));
    expect(await next).toBeUndefined();
    expect(shown().content.text).toBe("two");
  });
});

describe("every mutation settles, whatever throws", () => {
  test("a full localStorage during the optimistic apply rejects the edit and frees the chain", async () => {
    quota.arm();
    const err = await edit("one");
    expect((err as DOMException).name).toBe("QuotaExceededError");
    expect(requests).toHaveLength(0);
    // Rewound, and settled: no unsettled copy is left outranking server copies.
    expect(shown().content.text).toBe("original");
    expect(shown().localVersion).toBeUndefined();
    expect(retained(sentStore).content.text).toBe("original");

    // The next edit of the message is sent at once…
    const next = edit("two");
    await until(() => requests.length === 1);
    requests[0]?.answer(200, stored("two", E1));
    expect(await next).toBeUndefined();
    // …and a remote tombstone applies directly, not kept aside.
    tombstoneDmMessage(DM, "m1", E3);
    expect(shown().deletedAt).toBe(E3);
    expect(shown().serverCopy).toBeUndefined();
  });

  test("a full localStorage during an optimistic delete settles it the same way", async () => {
    quota.arm();
    const err = await deleteDm({ client, dmId: DM, message: shown(), me: ME, sentStore }).catch(
      (e: unknown) => e,
    );
    expect((err as DOMException).name).toBe("QuotaExceededError");
    expect(shown().deletedAt).toBeUndefined();
    expect(shown().localVersion).toBeUndefined();
    const next = edit("two");
    await until(() => requests.length === 1);
    requests[0]?.answer(200, stored("two", E1));
    expect(await next).toBeUndefined();
  });
});

describe("a hung request is bounded", () => {
  test("edit requests carry a deadline by default", async () => {
    const pending = edit("one");
    await until(() => requests.length === 1);
    expect(requests[0]?.signal).toBeDefined();
    requests[0]?.answer(200, stored("one", E1));
    expect(await pending).toBeUndefined();
  });

  test("past the deadline the edit is unconfirmed (kept) and the next one is sent", async () => {
    const hung = edit("one", { timeoutMs: 20 });
    const next = edit("two");
    await until(() => requests.length === 1);

    const err = await hung;
    expect(err).toBeInstanceOf(DmUnconfirmedError);
    expect(((err as DmUnconfirmedError).cause as DOMException).name).toBe("TimeoutError");
    expect(requests[0]?.signal?.aborted).toBe(true);

    await until(() => requests.length === 2);
    expect(requests[1]?.body?.content?.text).toBe("two");
    requests[1]?.answer(200, stored("two", E1));
    expect(await next).toBeUndefined();
    expect(shown().content.text).toBe("two");
  });

  test("a hung delete times out as unconfirmed and keeps its tombstone", async () => {
    const err = await deleteDm({
      client,
      dmId: DM,
      message: shown(),
      me: ME,
      sentStore,
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DmUnconfirmedError);
    expect(shown().deletedAt).toBeDefined();
    expect(retained(sentStore).deletedAt).toBeDefined();
  });
});
