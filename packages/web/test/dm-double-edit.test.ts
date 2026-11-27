/**
 * Two rapid edits of one DM, the second made before the first is confirmed
 * (`dm-mutation-chain.ts`): the requests go out in order, the first edit's
 * answer or a late / out-of-order `dm.message` never puts the first edit back on
 * screen, and the message settles on the last edit the user made once the
 * provider confirms it, or on the confirmed first edit when the second is
 * rejected.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { deleteDm, editDm } from "../src/components/dms/dm-mutations.ts";
import { DmSentStore } from "../src/lib/dm-store.ts";
import type { OfscpClient } from "../src/lib/ofscp-client.ts";
import { clearDms, tombstoneDmMessage, upsertDmMessage } from "../src/stores/dms.ts";
import { DM, memBackend, sent } from "./helpers/dm-fixtures.ts";
import {
  CREATED,
  E1,
  E2,
  E3,
  type Held,
  ME,
  drain,
  echo,
  heldClient,
  retained,
  shown,
  stored,
  until,
} from "./helpers/dm-held.ts";

describe("two rapid edits of one DM", () => {
  let sentStore: DmSentStore;
  let client: OfscpClient;
  let requests: Held[];
  /** Each edit's promise, settled (resolved or rejected) without failing the test. */
  let first: Promise<unknown>;
  let second: Promise<unknown>;

  beforeEach(() => {
    clearDms();
    sentStore = new DmSentStore(ME, memBackend());
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

  /** Make both edits back to back, as the row's editor does (the current copy each time). */
  function editTwice(): void {
    first = editDm({ client, dmId: DM, message: shown(), me: ME, text: "one", sentStore }).catch(
      (err: unknown) => err,
    );
    second = editDm({ client, dmId: DM, message: shown(), me: ME, text: "two", sentStore }).catch(
      (err: unknown) => err,
    );
  }

  test("the second request waits for the first, so the provider applies them in order", async () => {
    editTwice();
    expect(shown().content.text).toBe("two");
    await until(() => requests.length === 1);
    await drain();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body?.content?.text).toBe("one");

    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    expect(requests[1]?.body?.content?.text).toBe("two");
    requests[1]?.answer(200, stored("two", E2));
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
  });

  test("echoes in order: the first edit's answer and echo never show; the second's confirmation settles", async () => {
    editTwice();
    await until(() => requests.length === 1);

    upsertDmMessage(DM, echo("one", E1));
    expect(shown().content.text).toBe("two");
    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    expect(shown().content.text).toBe("two");
    expect(await first).toBeUndefined();

    upsertDmMessage(DM, echo("two", E2));
    expect(shown().content.text).toBe("two");
    requests[1]?.answer(200, stored("two", E2));
    expect(await second).toBeUndefined();

    expect(shown().content.text).toBe("two");
    expect(shown().editedAt).toBe(E2);
    expect(shown().localVersion).toBeUndefined();
    expect(shown().serverCopy).toBeUndefined();
    expect(retained(sentStore).content.text).toBe("two");
    expect(retained(sentStore).editedAt).toBe(E2);
    expect(retained(sentStore).localVersion).toBeUndefined();

    // A late duplicate of the first edit's echo is older: it changes nothing.
    upsertDmMessage(DM, echo("one", E1));
    expect(shown().content.text).toBe("two");
  });

  test("echoes out of order: the second edit's echo, then the first's, then the answers", async () => {
    editTwice();
    await until(() => requests.length === 1);
    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);

    upsertDmMessage(DM, echo("two", E2));
    upsertDmMessage(DM, echo("one", E1));
    expect(shown().content.text).toBe("two");
    requests[1]?.answer(200, stored("two", E2));
    expect(await second).toBeUndefined();

    expect(shown().content.text).toBe("two");
    expect(shown().editedAt).toBe(E2);
    expect(retained(sentStore).content.text).toBe("two");
  });

  test("the first edit's echo arriving only after the second edit settled changes nothing", async () => {
    editTwice();
    await until(() => requests.length === 1);
    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    requests[1]?.answer(200, stored("two", E2));
    expect(await second).toBeUndefined();

    upsertDmMessage(DM, echo("one", E1));
    upsertDmMessage(DM, echo("two", E2));
    expect(shown().content.text).toBe("two");
    expect(shown().editedAt).toBe(E2);
  });

  test("a rejected second edit rolls back to the confirmed first edit", async () => {
    editTwice();
    await until(() => requests.length === 1);
    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    upsertDmMessage(DM, echo("one", E1));
    expect(shown().content.text).toBe("two");

    requests[1]?.answer(403, { detail: "edit window closed" });
    expect(await second).toBeInstanceOf(Error);

    expect(shown().content.text).toBe("one");
    expect(shown().editedAt).toBe(E1);
    expect(shown().localVersion).toBeUndefined();
    expect(retained(sentStore).content.text).toBe("one");
    expect(retained(sentStore).editedAt).toBe(E1);
    expect(retained(sentStore).localVersion).toBeUndefined();
  });

  test("an unconfirmed second edit is kept, based on the confirmed first", async () => {
    editTwice();
    await until(() => requests.length === 1);
    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    requests[1]?.answer(502, { detail: "bad gateway" });
    await second;

    expect(shown().content.text).toBe("two");
    expect(shown().localVersion).toEqual({ basedOn: E1 });
    // The first edit's copy is the base: it cannot undo the kept edit…
    upsertDmMessage(DM, echo("one", E1));
    expect(shown().content.text).toBe("two");
    // …while the second edit's own server copy confirms it.
    upsertDmMessage(DM, echo("two", E2));
    expect(shown().editedAt).toBe(E2);
    expect(shown().localVersion).toBeUndefined();
  });

  test("a newer edit from another device that arrived meanwhile wins at the settle", async () => {
    editTwice();
    await until(() => requests.length === 1);
    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    upsertDmMessage(DM, echo("from my phone", E3));
    expect(shown().content.text).toBe("two");
    requests[1]?.answer(200, stored("two", E2));
    await second;

    expect(shown().content.text).toBe("from my phone");
    expect(shown().editedAt).toBe(E3);
    expect(retained(sentStore).content.text).toBe("from my phone");
  });

  test("a delete made while an edit is pending is sent after it and settles as a tombstone", async () => {
    const edit = editDm({ client, dmId: DM, message: shown(), me: ME, text: "one", sentStore });
    const del = deleteDm({ client, dmId: DM, message: shown(), me: ME, sentStore });
    expect(shown().deletedAt).toBeDefined();
    await until(() => requests.length === 1);
    await drain();
    expect(requests).toHaveLength(1);

    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    // The edit's echo cannot bring the deleted message back.
    upsertDmMessage(DM, echo("one", E1));
    expect(shown().deletedAt).toBeDefined();
    expect(requests[1]?.method).toBe("DELETE");
    requests[1]?.answer(204);
    await edit;
    await del;

    expect(shown().deletedAt).toBeDefined();
    expect(shown().content.text).toBe("");
    expect(shown().localVersion).toBeUndefined();
    expect(retained(sentStore).deletedAt).toBeDefined();
  });

  test("a tombstone from another device that arrived meanwhile wins at the settle", async () => {
    editTwice();
    await until(() => requests.length === 1);
    tombstoneDmMessage(DM, "m1", E3);
    expect(shown().content.text).toBe("two");
    requests[0]?.answer(200, stored("one", E1));
    await until(() => requests.length === 2);
    requests[1]?.answer(200, stored("two", E2));
    await second;

    expect(shown().deletedAt).toBe(E3);
    expect(shown().content.text).toBe("");
  });
});
