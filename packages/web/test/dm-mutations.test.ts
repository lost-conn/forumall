/** DM edit/delete (`dm-mutations.ts`): what an unconfirmed or rejected mutation leaves in both stores. */
import { beforeEach, describe, expect, test } from "bun:test";
import { DmUnconfirmedError } from "../src/components/dms/dm-errors.ts";
import { deleteDm, editDm } from "../src/components/dms/dm-mutations.ts";
import { DmSentStore } from "../src/lib/dm-store.ts";
import { OfscpClient } from "../src/lib/ofscp-client.ts";
import { clearDms, dmThread, upsertDmMessage } from "../src/stores/dms.ts";
import { DM, memBackend, sent } from "./helpers/dm-fixtures.ts";

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

/**
 * §5.3 `mentions` is authoritative and §7.1 keeps a field an edit omits, so a DM
 * edit sends the list recomputed from the new text — `[]` once it names nobody —
 * with bare `@handle`s resolved against the provider holding the message.
 */
describe("editDm: resends `mentions` for the new text", () => {
  beforeEach(() => clearDms());

  /** A client on `host` that records each request body and answers 200. */
  const recordingClient = (host: string, bodies: unknown[]): OfscpClient =>
    new OfscpClient({
      baseUrl: `https://${host}`,
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: "m1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

  const mine = {
    id: "m1",
    author: "me@h",
    content: { mime: "text/plain", text: "hi @bob" },
    createdAt: "2026-06-05T00:00:00Z",
  };

  test("an edit naming users sends their actors, bare handles at the holding provider", async () => {
    const home: unknown[] = [];
    const remote: unknown[] = [];
    await editDm({
      client: recordingClient("h.example", home),
      deliveryClient: recordingClient("other.example", remote),
      dmId: DM,
      message: mine,
      me: "me@h",
      text: "now @carol and @dave@third.example",
      sentStore: new DmSentStore("me@h", memBackend()),
    });
    expect(home).toEqual([]);
    expect(remote).toEqual([
      {
        content: { mime: "text/plain", text: "now @carol and @dave@third.example" },
        mentions: ["carol@other.example", "dave@third.example"],
      },
    ]);
  });

  test("an edit that drops every mention sends `mentions: []`", async () => {
    const bodies: unknown[] = [];
    await editDm({
      client: recordingClient("h.example", bodies),
      dmId: DM,
      message: mine,
      me: "me@h",
      text: "never mind",
      sentStore: new DmSentStore("me@h", memBackend()),
    });
    expect(bodies).toEqual([{ content: { mime: "text/plain", text: "never mind" }, mentions: [] }]);
  });
});
