/**
 * Read-marker store + REST surface (OFSCP §7.7).
 *
 *  - `markRead` PATCHes exactly the spec body `{ markers: [{ scopeId,
 *    lastReadMessageId }] }` for channels and DMs — no seq, nothing else.
 *  - The summary and `read.updated` are read by the spec fields only.
 *  - The space-rail rollup (`unreadForGroup`) attributes unread via each channel
 *    scope's `groupId`; DM scopes roll into no group.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReadMarker } from "@forumall/shared";
import type { StoredSession } from "../src/lib/auth.ts";
import type { OfscpClient } from "../src/lib/ofscp-client.ts";
import { getReadMarkers, setReadMarkers } from "../src/lib/read-markers-api.ts";
import {
  applyReadUpdated,
  clearReadMarkers,
  hydrateReadMarkers,
  markRead,
  readSnapshotFor,
  readState,
  totalUnread,
  unreadForGroup,
} from "../src/stores/read-markers.ts";
import { clearSession, setSessionAuth } from "../src/stores/session.ts";

interface Call {
  method: "GET" | "PATCH";
  path: string;
  body?: unknown;
}

/** A client that records requests and answers PATCH/GET from the given queues. */
function recordingClient(answers: { patch?: ReadMarker[][]; get?: ReadMarker[][] } = {}) {
  const calls: Call[] = [];
  const client = {
    async get(path: string) {
      calls.push({ method: "GET", path });
      return { data: { scopes: answers.get?.shift() ?? [] } };
    },
    async patch(path: string, body: unknown) {
      calls.push({ method: "PATCH", path, body });
      return { data: { scopes: answers.patch?.shift() ?? [] } };
    },
  } as unknown as OfscpClient;
  return { client, calls };
}

const STORED = {
  actor: "alice@providera.test",
  host: "providera.test",
  keyId: "key_1",
  handle: "alice",
  deviceName: "test",
} as StoredSession;

/** Let pending promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => clearReadMarkers());
afterEach(() => clearSession());

describe("read-markers-api", () => {
  test("setReadMarkers PATCHes exactly { markers: [{ scopeId, lastReadMessageId }] }", async () => {
    const { client, calls } = recordingClient();
    const extra = { scopeId: "chn_a", lastReadMessageId: "msg_1", lastReadSeq: 9 };
    await setReadMarkers(client, [extra, { scopeId: "dm_x", lastReadMessageId: "msg_2" }]);
    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/me/read-markers",
        body: {
          markers: [
            { scopeId: "chn_a", lastReadMessageId: "msg_1" },
            { scopeId: "dm_x", lastReadMessageId: "msg_2" },
          ],
        },
      },
    ]);
  });

  test("setReadMarkers with nothing to send makes no request", async () => {
    const { client, calls } = recordingClient();
    expect(await setReadMarkers(client, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("getReadMarkers reads the spec summary", async () => {
    const scopes = [{ scopeId: "chn_a", lastReadMessageId: "msg_1", unreadCount: 2 }];
    const { client, calls } = recordingClient({ get: [scopes] });
    expect(await getReadMarkers(client)).toEqual(scopes);
    expect(calls).toEqual([{ method: "GET", path: "/api/me/read-markers" }]);
  });
});

describe("markRead", () => {
  test("sends the spec body for a channel and for a DM, and zeros unread", async () => {
    const { client, calls } = recordingClient({
      patch: [
        [{ scopeId: "chn_a", lastReadMessageId: "msg_9", unreadCount: 0, groupId: "grp_1" }],
        [{ scopeId: "dm_x", lastReadMessageId: "msg_7", unreadCount: 0 }],
      ],
    });
    setSessionAuth({ client, stored: STORED });
    applyReadUpdated([{ scopeId: "chn_a", unreadCount: 4, groupId: "grp_1" }]);

    markRead("chn_a", "msg_9");
    expect({ ...readState.scopes.chn_a }).toEqual({
      lastReadMessageId: "msg_9",
      unreadCount: 0,
      groupId: "grp_1",
    });
    markRead("dm_x", "msg_7");
    await settle();

    expect(calls.map((c) => c.body)).toEqual([
      { markers: [{ scopeId: "chn_a", lastReadMessageId: "msg_9" }] },
      { markers: [{ scopeId: "dm_x", lastReadMessageId: "msg_7" }] },
    ]);
    expect(readSnapshotFor("dm_x")).toEqual({ lastReadMessageId: "msg_7", unreadCount: 0 });
  });

  test("no id, or the id already marked, sends nothing", async () => {
    const { client, calls } = recordingClient();
    setSessionAuth({ client, stored: STORED });
    applyReadUpdated([{ scopeId: "chn_a", lastReadMessageId: "msg_1", unreadCount: 0 }]);
    markRead("chn_a", undefined);
    markRead("chn_a", "msg_1");
    await settle();
    expect(calls).toEqual([]);
  });

  test("a mark the provider did not advance re-reads the summary", async () => {
    const { client, calls } = recordingClient({
      patch: [[]],
      get: [[{ scopeId: "chn_a", lastReadMessageId: "msg_newer", unreadCount: 0 }]],
    });
    setSessionAuth({ client, stored: STORED });
    markRead("chn_a", "msg_older");
    await settle();
    await settle();
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "GET"]);
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_newer", unreadCount: 0 });
  });

  test("a stale PATCH answer does not overwrite a newer local mark", async () => {
    const { client } = recordingClient({
      patch: [
        [{ scopeId: "chn_a", lastReadMessageId: "msg_1", unreadCount: 3 }],
        [{ scopeId: "chn_a", lastReadMessageId: "msg_2", unreadCount: 0 }],
      ],
    });
    setSessionAuth({ client, stored: STORED });
    markRead("chn_a", "msg_1");
    markRead("chn_a", "msg_2");
    await settle();
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_2", unreadCount: 0 });
  });
});

describe("summary and read.updated", () => {
  test("hydrate stores the spec fields; an absent marker stays absent", async () => {
    const { client } = recordingClient({
      get: [
        [
          { scopeId: "chn_a", lastReadMessageId: "msg_1", unreadCount: 2, groupId: "grp_1" },
          { scopeId: "dm_x", unreadCount: 5 },
        ],
      ],
    });
    setSessionAuth({ client, stored: STORED });
    await hydrateReadMarkers();
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_1", unreadCount: 2 });
    expect(readSnapshotFor("dm_x")).toEqual({ unreadCount: 5 });
    expect(readSnapshotFor("chn_unknown")).toEqual({ unreadCount: 0 });
  });
});

describe("unreadForGroup rolls up by groupId", () => {
  test("sums channel scopes by their groupId with no chat.channels present", () => {
    applyReadUpdated([
      { scopeId: "chn_a", unreadCount: 3, groupId: "grp_1" },
      { scopeId: "chn_b", unreadCount: 2, groupId: "grp_1" },
      { scopeId: "chn_c", unreadCount: 5, groupId: "grp_2" },
      // A DM scope: no groupId — must not count toward any group.
      { scopeId: "dm_x", unreadCount: 7 },
    ]);
    expect(unreadForGroup("grp_1")).toBe(5);
    expect(unreadForGroup("grp_2")).toBe(5);
    expect(unreadForGroup("grp_unknown")).toBe(0);
    expect(totalUnread()).toBe(17);
  });

  test("a read.updated that omits groupId preserves the prior attribution", () => {
    applyReadUpdated([{ scopeId: "chn_a", unreadCount: 4, groupId: "grp_1" }]);
    expect(unreadForGroup("grp_1")).toBe(4);
    applyReadUpdated([{ scopeId: "chn_a", lastReadMessageId: "msg_5", unreadCount: 0 }]);
    expect(unreadForGroup("grp_1")).toBe(0);
    applyReadUpdated([{ scopeId: "chn_a", lastReadMessageId: "msg_6", unreadCount: 2 }]);
    expect(unreadForGroup("grp_1")).toBe(2);
  });
});

/** A client whose PATCHes wait until the test answers (or fails) them in turn. */
function deferredClient(get: ReadMarker[][] = []) {
  const patches: { body: unknown; answer(scopes: ReadMarker[]): void; fail(): void }[] = [];
  let gets = 0;
  const client = {
    async get() {
      gets++;
      return { data: { scopes: get.shift() ?? [] } };
    },
    patch(_path: string, body: unknown) {
      return new Promise((resolve, reject) => {
        patches.push({
          body,
          answer: (scopes) => resolve({ data: { scopes } }),
          fail: () => reject(new Error("offline")),
        });
      });
    },
  } as unknown as OfscpClient;
  return { client, patches, gets: () => gets };
}

describe("a pending local mark is never rolled back", () => {
  const at = (id: string, unreadCount = 0): ReadMarker => ({
    scopeId: "chn_a",
    lastReadMessageId: id,
    unreadCount,
  });

  test("a late read.updated for an earlier mark does not move the marker back", async () => {
    const { client, patches } = deferredClient();
    setSessionAuth({ client, stored: STORED });
    markRead("chn_a", "msg_1");
    markRead("chn_a", "msg_2");

    // msg_1's answer arrives, then its read.updated — both while msg_2 waits.
    patches[0]?.answer([at("msg_1", 1)]);
    await settle();
    applyReadUpdated([at("msg_1", 1)]);
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_2", unreadCount: 0 });

    // msg_2's own read.updated confirms it, and its answer settles it.
    applyReadUpdated([at("msg_2")]);
    patches[1]?.answer([at("msg_2")]);
    await settle();
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_2", unreadCount: 0 });

    // Nothing pending any more: another device's advance applies.
    applyReadUpdated([at("msg_3")]);
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_3", unreadCount: 0 });
  });

  test("a summary read while a mark is pending keeps the mark, even one an earlier answer asked for", async () => {
    const { client, patches, gets } = deferredClient([[at("msg_0", 4)], [at("msg_2")]]);
    setSessionAuth({ client, stored: STORED });
    markRead("chn_a", "msg_1");
    markRead("chn_a", "msg_2");

    // msg_1 did not advance → the summary is re-read; it predates msg_2's PATCH.
    patches[0]?.answer([]);
    await settle();
    await settle();
    expect(gets()).toBe(1);
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_2", unreadCount: 0 });

    // A summary that already names the pending mark applies.
    await hydrateReadMarkers();
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_2", unreadCount: 0 });
    patches[1]?.answer([at("msg_2")]);
    await settle();
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_2", unreadCount: 0 });
  });

  test("a failed PATCH stops guarding the mark and re-reads the summary", async () => {
    const { client, patches } = deferredClient([[at("msg_0", 3)]]);
    setSessionAuth({ client, stored: STORED });
    markRead("chn_a", "msg_1");
    patches[0]?.fail();
    await settle();
    await settle();
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_0", unreadCount: 3 });
    applyReadUpdated([at("msg_4")]);
    expect(readSnapshotFor("chn_a")).toEqual({ lastReadMessageId: "msg_4", unreadCount: 0 });
  });
});
