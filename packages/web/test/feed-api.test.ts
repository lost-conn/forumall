/**
 * Follow group resolution (§7.6): a `Follow`'s derived `groupId` is a local id
 * for a channel on the follow's provider and the group's object URI for a remote
 * channel; the feed reads each channel at its own provider, so it needs the
 * local id the channel's provider uses in its paths either way.
 */
import { describe, expect, test } from "bun:test";
import type { Follow } from "@forumall/shared";

import { followGroupId, localGroupId } from "../src/lib/feed-api.ts";

const T = "2026-02-01T09:00:00Z";

describe("localGroupId", () => {
  test("a bare id is its own local id", () => {
    expect(localGroupId("grp_1")).toBe("grp_1");
  });

  test("a group object URI → its {groupId}", () => {
    expect(localGroupId("https://a.com/api/groups/grp_1")).toBe("grp_1");
  });

  test("a URI not shaped like a group URI → null", () => {
    expect(localGroupId("https://a.com/api/groups/grp_1/channels/chn_x")).toBeNull();
    expect(localGroupId("https://a.com/g/grp_1")).toBeNull();
  });
});

describe("followGroupId", () => {
  test("a local follow's derived local groupId", () => {
    const f: Follow = { channel: "chn_general", groupId: "grp_1", createdAt: T, metadata: [] };
    expect(followGroupId(f)).toBe("grp_1");
  });

  test("a remote follow's derived group URI → the remote provider's local id", () => {
    const f: Follow = {
      channel: "https://a.com/api/groups/grp_1/channels/chn_blog",
      groupId: "https://a.com/api/groups/grp_1",
      createdAt: T,
      metadata: [],
    };
    expect(followGroupId(f)).toBe("grp_1");
  });

  test("no groupId → the group a channel URI names, else null", () => {
    const uri: Follow = {
      channel: "https://a.com/api/groups/grp_2/channels/chn_blog",
      createdAt: T,
      metadata: [],
    };
    expect(followGroupId(uri)).toBe("grp_2");
    const bare: Follow = { channel: "chn_gone", createdAt: T, metadata: [] };
    expect(followGroupId(bare)).toBeNull();
  });
});
