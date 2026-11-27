/**
 * Read markers & unread counts (§7.7) — storage and aggregation.
 *
 * Covers:
 *  - `setReadMarkers` / `getReadMarkers` round-trip (the storage form: a `seq`).
 *  - The monotonic guard: a backward or equal set is ignored.
 *  - Unread counts exclude the user's OWN messages, for channels and DMs.
 *  - Unread counts drop as a marker advances.
 *  - Tombstones still count as unread (they keep their id and timeline
 *    position, §7.1), for channels and DMs, and the count is exact.
 *
 * The wire surface (`GET`/`PATCH /api/me/read-markers`) is in
 * `read-markers-http.test.ts`; live-body schema conformance in
 * `read-markers-conformance.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveDmId } from "@forumall/shared";

import { tombstoneDmMessage } from "../src/provider/dm-edits.ts";
import { tombstoneMessage } from "../src/provider/messages.ts";
import { getReadMarkers, getUnreadSummary, setReadMarkers } from "../src/provider/read-markers.ts";
import { type Booted, boot, registerUserWithKey } from "./helpers/provider-harness.ts";
import { dmTo, handleOf, post, seedGroupChannel } from "./helpers/read-markers-fixtures.ts";

let tmp: string;
const booted: Booted[] = [];
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "forumall-readmarkers-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const b of booted.splice(0)) b.server.stop(true);
});

function start(name: string): Booted {
  const b = boot(tmp, name);
  booted.push(b);
  return b;
}

/** `handle`'s unread count for `scopeId` from the summary (`undefined` if unlisted). */
function unread(b: Booted, handle: string, actor: string, scopeId: string): number | undefined {
  return getUnreadSummary(b.db, handle, actor).find((s) => s.scopeId === scopeId)?.unreadCount;
}

describe("read-markers storage", () => {
  test("set + get round-trip", () => {
    const b = start("rm-roundtrip");
    setReadMarkers(b.db, "alice", [
      { scopeId: "chn_a", lastReadSeq: 5 },
      { scopeId: "chn_b", lastReadSeq: 9 },
    ]);
    const got = getReadMarkers(b.db, "alice");
    expect(got.get("chn_a")).toBe(5);
    expect(got.get("chn_b")).toBe(9);
  });

  test("monotonic: a backward or equal set is ignored", () => {
    const b = start("rm-monotonic");
    expect(
      setReadMarkers(b.db, "alice", [{ scopeId: "chn_a", lastReadSeq: 10 }]).has("chn_a"),
    ).toBe(true);
    expect(setReadMarkers(b.db, "alice", [{ scopeId: "chn_a", lastReadSeq: 4 }]).has("chn_a")).toBe(
      false,
    );
    expect(
      setReadMarkers(b.db, "alice", [{ scopeId: "chn_a", lastReadSeq: 10 }]).has("chn_a"),
    ).toBe(false);
    expect(getReadMarkers(b.db, "alice").get("chn_a")).toBe(10);
    expect(
      setReadMarkers(b.db, "alice", [{ scopeId: "chn_a", lastReadSeq: 11 }]).has("chn_a"),
    ).toBe(true);
    expect(getReadMarkers(b.db, "alice").get("chn_a")).toBe(11);
  });
});

describe("unread counts", () => {
  test("channel unread excludes the user's OWN messages and carries the group", async () => {
    const b = start("rm-own");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = seedGroupChannel(b, alice, [bob]);
    post(b, groupId, channelId, bob, "hi");
    post(b, groupId, channelId, alice, "my own");
    post(b, groupId, channelId, bob, "again");

    const entry = getUnreadSummary(b.db, "alice", alice.actor).find((s) => s.scopeId === channelId);
    expect(entry?.unreadCount).toBe(2);
    expect(entry?.groupId).toBe(groupId);
    // Nothing read yet → no marker on the wire.
    expect(entry?.lastReadMessageId).toBeUndefined();
    expect(unread(b, "bob", bob.actor, channelId)).toBe(1);
  });

  test("channel unread drops as the marker advances; the entry names the message", async () => {
    const b = start("rm-advance");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = seedGroupChannel(b, alice, [bob]);
    post(b, groupId, channelId, bob, "1");
    const m2 = post(b, groupId, channelId, bob, "2");
    post(b, groupId, channelId, bob, "3");
    expect(unread(b, "alice", alice.actor, channelId)).toBe(3);

    setReadMarkers(b.db, "alice", [{ scopeId: channelId, lastReadSeq: m2.seq }]);
    const entry = getUnreadSummary(b.db, "alice", alice.actor).find((s) => s.scopeId === channelId);
    expect(entry?.unreadCount).toBe(1);
    expect(entry?.lastReadMessageId).toBe(m2.id);
    // The provider-internal seq never appears in a wire entry.
    expect(entry && "lastReadSeq" in entry).toBe(false);
  });

  test("DM unread counts inbox messages from the counterparty", async () => {
    const b = start("rm-dm");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    dmTo(b, dmId, alice, bob, "yo");
    dmTo(b, dmId, alice, alice, "mine");
    const last = dmTo(b, dmId, alice, bob, "again");

    const entry = getUnreadSummary(b.db, "alice", alice.actor).find((s) => s.scopeId === dmId);
    expect(entry?.unreadCount).toBe(2);
    expect(entry?.groupId).toBeUndefined();

    setReadMarkers(b.db, "alice", [{ scopeId: dmId, lastReadSeq: last.seq }]);
    expect(unread(b, "alice", alice.actor, dmId)).toBe(0);
  });

  test("channel tombstones still count as unread, exactly", async () => {
    const b = start("rm-tomb-channel");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const { groupId, channelId } = seedGroupChannel(b, alice, [bob]);
    const read = post(b, groupId, channelId, bob, "read");
    setReadMarkers(b.db, "alice", [{ scopeId: channelId, lastReadSeq: read.seq }]);
    const doomed = post(b, groupId, channelId, bob, "deleted later");
    post(b, groupId, channelId, bob, "kept");
    const ownDoomed = post(b, groupId, channelId, alice, "own, deleted");
    expect(unread(b, "alice", alice.actor, channelId)).toBe(2);

    // Deleting keeps the row as a tombstone at its timeline position (§7.1): it
    // is still newer than the marker, so the count does not drop. The user's
    // own tombstone stays excluded.
    expect(tombstoneMessage(b.db, channelId, doomed.id).message.deletedAt).toBeDefined();
    tombstoneMessage(b.db, channelId, ownDoomed.id);
    expect(unread(b, "alice", alice.actor, channelId)).toBe(2);

    // The marker may name the tombstone itself; the count then drops past it.
    setReadMarkers(b.db, "alice", [{ scopeId: channelId, lastReadSeq: doomed.seq }]);
    const entry = getUnreadSummary(b.db, "alice", alice.actor).find((s) => s.scopeId === channelId);
    expect(entry?.unreadCount).toBe(1);
    expect(entry?.lastReadMessageId).toBe(doomed.id);
  });

  test("DM tombstones still count as unread", async () => {
    const b = start("rm-tomb-dm");
    const alice = await registerUserWithKey(b, "alice");
    const bob = await registerUserWithKey(b, "bob");
    const dmId = deriveDmId(alice.actor, bob.actor);
    const first = dmTo(b, dmId, alice, bob, "read");
    setReadMarkers(b.db, "alice", [{ scopeId: dmId, lastReadSeq: first.seq }]);
    const doomed = dmTo(b, dmId, alice, bob, "deleted later");
    dmTo(b, dmId, alice, bob, "kept");
    expect(unread(b, "alice", alice.actor, dmId)).toBe(2);

    expect(
      tombstoneDmMessage(b.db, handleOf(alice), dmId, doomed.id).message.deletedAt,
    ).toBeDefined();
    expect(unread(b, "alice", alice.actor, dmId)).toBe(2);
  });
});
