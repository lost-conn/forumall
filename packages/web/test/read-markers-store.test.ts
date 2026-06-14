/**
 * Read-marker store unit tests (provider-local extension).
 *
 * The space-rail group rollup (`unreadForGroup`) must attribute unread to a group
 * via the `groupId` carried on each channel scope in the unread summary —
 * independently of whether the channel has been opened this session (i.e. without
 * any `chat.channels` entries). DM scopes have no groupId and must not be rolled
 * into any group.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ReadMarker } from "@forumall/shared";
import {
  applyReadUpdated,
  clearReadMarkers,
  totalUnread,
  unreadForGroup,
} from "../src/stores/read-markers.ts";

beforeEach(() => clearReadMarkers());

describe("unreadForGroup rolls up by groupId", () => {
  test("sums channel scopes by their groupId with no chat.channels present", () => {
    const markers: ReadMarker[] = [
      { scopeId: "chn_a", lastReadSeq: 0, unreadCount: 3, groupId: "grp_1" },
      { scopeId: "chn_b", lastReadSeq: 0, unreadCount: 2, groupId: "grp_1" },
      { scopeId: "chn_c", lastReadSeq: 0, unreadCount: 5, groupId: "grp_2" },
      // A DM scope: no groupId — must not count toward any group.
      { scopeId: "dm:alice:bob", lastReadSeq: 0, unreadCount: 7 },
    ];
    applyReadUpdated(markers);

    expect(unreadForGroup("grp_1")).toBe(5);
    expect(unreadForGroup("grp_2")).toBe(5);
    expect(unreadForGroup("grp_unknown")).toBe(0);
    // Total still spans every scope including DMs.
    expect(totalUnread()).toBe(17);
  });

  test("a read.updated that omits groupId preserves the prior attribution", () => {
    applyReadUpdated([{ scopeId: "chn_a", lastReadSeq: 0, unreadCount: 4, groupId: "grp_1" }]);
    expect(unreadForGroup("grp_1")).toBe(4);

    // A later event for the same scope advances the marker but omits groupId;
    // the rollup must still attribute it to grp_1.
    applyReadUpdated([{ scopeId: "chn_a", lastReadSeq: 5, unreadCount: 0 }]);
    expect(unreadForGroup("grp_1")).toBe(0);
    // Re-raise the count via a fresh event (still no groupId) → still grp_1.
    applyReadUpdated([{ scopeId: "chn_a", lastReadSeq: 6, unreadCount: 2 }]);
    expect(unreadForGroup("grp_1")).toBe(2);
  });
});
