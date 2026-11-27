/**
 * An optimistic local edit is ordered without the client's clock
 * (`lib/merge-message.ts`): it ranks just above the server version it was made
 * from, so the provider's confirming copy replaces it however fast the
 * client's clock runs, while a stale copy (an older history page) still cannot
 * undo it — before or after the confirmation lands.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { editDm } from "../src/components/dms/dm-mutations.ts";
import { DmSentStore } from "../src/lib/dm-store.ts";
import { isOlderCopy, localVersionOf } from "../src/lib/merge-message.ts";
import { OfscpClient } from "../src/lib/ofscp-client.ts";
import { type DmMessage, clearDms, dmThread, upsertDmMessage } from "../src/stores/dms.ts";
import { DM, memBackend, sent } from "./helpers/dm-fixtures.ts";

/** The first item of a list, failing the test when there is none. */
function first<T>(list: readonly T[]): T {
  const item = list[0];
  if (item === undefined) throw new Error("empty list");
  return item;
}

const CREATED = "2026-11-27T10:00:00Z";
/** The provider's stamp on the first, already confirmed edit. */
const SERVER_EDIT_1 = "2026-11-27T10:05:00Z";
/** The provider's stamp on the edit under test (the confirmation). */
const SERVER_EDIT_2 = "2026-11-27T10:10:00Z";
/** A client clock running a day fast. */
const FAST_CLOCK = new Date("2026-11-28T10:10:00Z");

describe("isOlderCopy: local edits are ordered by their base, not by the client clock", () => {
  const server = (editedAt?: string) => (editedAt ? { editedAt } : {});
  const local = (displayStamp: string, basedOn?: string) => ({
    editedAt: displayStamp,
    localVersion: basedOn !== undefined ? { basedOn } : {},
  });

  test("a server copy newer than the base outranks a fast-clock local edit", () => {
    expect(isOlderCopy(local("2099-01-01T00:00:00Z"), server(SERVER_EDIT_2))).toBe(false);
    expect(isOlderCopy(local("2099-01-01T00:00:00Z", SERVER_EDIT_1), server(SERVER_EDIT_2))).toBe(
      false,
    );
  });

  test("the base itself, or anything older, is a stale copy that loses", () => {
    expect(isOlderCopy(local("2000-01-01T00:00:00Z"), server())).toBe(true);
    const onEdit1 = local("2000-01-01T00:00:00Z", SERVER_EDIT_1);
    expect(isOlderCopy(onEdit1, server(SERVER_EDIT_1))).toBe(true);
    expect(isOlderCopy(onEdit1, server())).toBe(true);
    expect(isOlderCopy(onEdit1, server("2026-11-27T10:01:00Z"))).toBe(true);
  });

  test("a local edit outranks its base and older copies, but not a later server copy", () => {
    const slowClock = local("2000-01-01T00:00:00Z", SERVER_EDIT_1);
    expect(isOlderCopy(server(SERVER_EDIT_1), slowClock)).toBe(false);
    expect(isOlderCopy(server(), slowClock)).toBe(false);
    expect(isOlderCopy(server(SERVER_EDIT_2), slowClock)).toBe(true);
  });

  test("an unsettled local mutation outranks every server copy, a tombstone included", () => {
    const unsettled = {
      editedAt: "2000-01-01T00:00:00Z",
      localVersion: { unsettled: true as const },
    };
    expect(isOlderCopy(unsettled, server(SERVER_EDIT_2))).toBe(true);
    expect(isOlderCopy(unsettled, { deletedAt: SERVER_EDIT_2 })).toBe(true);
    // A new unsettled copy is the user's latest intent: it wins over anything stored.
    expect(isOlderCopy(server(SERVER_EDIT_2), unsettled)).toBe(false);
    expect(isOlderCopy(unsettled, { ...unsettled })).toBe(false);
    // Settled, it is ordered by its base again.
    expect(localVersionOf(unsettled)).toEqual({});
  });

  test("a new local edit over an unconfirmed one keeps its base and wins", () => {
    const pending = local("2026-11-27T10:06:00Z", SERVER_EDIT_1);
    const next = { editedAt: "2026-11-27T10:07:00Z", localVersion: localVersionOf(pending) };
    expect(next.localVersion).toEqual({ basedOn: SERVER_EDIT_1 });
    expect(isOlderCopy(pending, next)).toBe(false);
    expect(localVersionOf(server(SERVER_EDIT_1))).toEqual({ basedOn: SERVER_EDIT_1 });
    expect(localVersionOf(server())).toEqual({});
  });
});

describe("editDm: the provider's confirmation replaces the local edit", () => {
  beforeEach(() => clearDms());
  afterEach(() => setSystemTime());

  /**
   * One of the caller's own messages, already edited once (confirmed). A fresh
   * object each call: the store adopts (and later mutates) what it is given.
   */
  const original = (): DmMessage => ({
    id: "m1",
    author: "alice@h.example",
    content: { mime: "text/markdown", text: "first edit" },
    createdAt: CREATED,
    editedAt: SERVER_EDIT_1,
    mine: true,
  });

  /** A client whose `PATCH` answers with the stored message, as the provider does. */
  const answeringClient = (stored: Record<string, unknown>): OfscpClient =>
    new OfscpClient({
      baseUrl: "https://h",
      fetch: (async () =>
        new Response(JSON.stringify(stored), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

  /** The provider's stored copy after the edit: its own `editedAt`, a server field. */
  const storedAfterEdit = {
    id: "m1",
    type: "message",
    author: "alice@h.example",
    content: { mime: "text/markdown", text: "**second** edit" },
    createdAt: CREATED,
    editedAt: SERVER_EDIT_2,
    attachments: [],
    metadata: [],
  };

  /** Seed both stores with the message, then edit it with the client clock a day fast. */
  async function editWithFastClock(): Promise<DmSentStore> {
    const sentStore = new DmSentStore("alice@h.example", memBackend());
    upsertDmMessage(DM, original());
    sentStore.append(
      DM,
      sent({
        id: "m1",
        author: "alice@h.example",
        content: original().content,
        createdAt: CREATED,
        editedAt: SERVER_EDIT_1,
      }),
    );
    setSystemTime(FAST_CLOCK);
    await editDm({
      client: answeringClient(storedAfterEdit),
      dmId: DM,
      message: original(),
      me: "alice@h.example",
      text: "**second** edit",
      sentStore,
    });
    return sentStore;
  }

  test("a fast client clock: the server confirmation still wins in both stores", async () => {
    const sentStore = await editWithFastClock();

    const stored = first(dmThread(DM));
    expect(stored.content.text).toBe("**second** edit");
    expect(stored.editedAt).toBe(SERVER_EDIT_2);
    expect(stored.localVersion).toBeUndefined();
    const retained = first(sentStore.list(DM));
    expect(retained.editedAt).toBe(SERVER_EDIT_2);
    expect(retained.localVersion).toBeUndefined();
  });

  test("a stale history page still loses to the confirmed edit", async () => {
    const sentStore = await editWithFastClock();
    const stalePage = { ...original(), cursor: "c_stale" };
    upsertDmMessage(DM, stalePage);
    sentStore.mergeCopy(DM, sent({ ...stalePage, author: "alice@h.example" }));

    const stored = first(dmThread(DM));
    expect(stored.content.text).toBe("**second** edit");
    expect(stored.editedAt).toBe(SERVER_EDIT_2);
    expect(stored.cursor).toBe("c_stale");
    expect(first(sentStore.list(DM)).content.text).toBe("**second** edit");
  });

  test("an answer that is not the message keeps the local edit until a server copy confirms it", async () => {
    const sentStore = new DmSentStore("alice@h.example", memBackend());
    upsertDmMessage(DM, original());
    sentStore.append(
      DM,
      sent({ id: "m1", author: "alice@h.example", content: original().content }),
    );
    setSystemTime(FAST_CLOCK);
    await editDm({
      client: answeringClient({ id: "m1" }),
      dmId: DM,
      message: original(),
      me: "alice@h.example",
      text: "**second** edit",
      sentStore,
    });
    const pending = first(dmThread(DM));
    expect(pending.localVersion).toEqual({ basedOn: SERVER_EDIT_1 });
    expect(Date.parse(pending.editedAt ?? "")).toBe(FAST_CLOCK.getTime());
    expect(first(sentStore.list(DM)).localVersion).toEqual({ basedOn: SERVER_EDIT_1 });

    // A stale history page (the base version) loses to the pending local edit…
    upsertDmMessage(DM, original());
    expect(first(dmThread(DM)).content.text).toBe("**second** edit");
    // …and the live server copy of the edit confirms it, despite the fast clock.
    upsertDmMessage(DM, { ...original(), ...storedAfterEdit, mine: true });
    const confirmed = first(dmThread(DM));
    expect(confirmed.editedAt).toBe(SERVER_EDIT_2);
    expect(confirmed.localVersion).toBeUndefined();
  });
});
