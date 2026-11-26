/**
 * Rules of the OFSCP content / media / membership schemas that the spec
 * samples alone do not pin down: the at-least-one-field rule for edits (§7.1
 * Editing), nullable article fields, the no-nested-thumbnail rule (§5.8),
 * `Group.membership` (§5.5), and the `groups.updated` event (§5.7 My groups).
 */
import { describe, expect, test } from "bun:test";

import {
  AttachmentSchema,
  GroupPointersResponseSchema,
  GroupSchema,
  MessageCreateRequestSchema,
  MessageSchema,
  MessageUpdateRequestSchema,
  WsGroupsUpdatedSchema,
  WsMessageUpdateSchema,
  carriesAnEditField,
  isKnownWsType,
} from "../src/schemas/index.ts";

const TS = "2026-01-01T12:00:00Z";
const TARGET = { groupId: "grp_1", channelId: "chn_1", messageId: "msg_1" };

function wsUpdate(data: Record<string, unknown>) {
  return { id: "cli_1", type: "message.update", ts: TS, data: { ...TARGET, ...data } };
}

describe("MessageUpdate (§7.1 Editing): at least one field", () => {
  test("an edit carrying no field is rejected, over REST and WS", () => {
    expect(MessageUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(WsMessageUpdateSchema.safeParse(wsUpdate({})).success).toBe(false);
  });

  test("keys that are not edit fields do not count (type, reference, metadata)", () => {
    const body = { type: "article", reference: { type: "reply", id: "msg_0" }, metadata: [] };
    expect(MessageUpdateRequestSchema.safeParse(body).success).toBe(false);
    expect(WsMessageUpdateSchema.safeParse(wsUpdate(body)).success).toBe(false);
  });

  test("each edit field on its own is enough", () => {
    const single: Record<string, unknown>[] = [
      { content: { text: "x", mime: "text/plain" } },
      { attachments: [] },
      { tags: ["#a"] },
      { mentions: ["bob@b.com"] },
      { title: "T" },
      { summary: "S" },
      { cover: "att_1" },
    ];
    for (const body of single) {
      expect(MessageUpdateRequestSchema.safeParse(body).success).toBe(true);
      expect(WsMessageUpdateSchema.safeParse(wsUpdate(body)).success).toBe(true);
    }
  });

  test("null removes an article field and still counts as a field", () => {
    for (const body of [{ title: null }, { summary: null }, { cover: null }]) {
      expect(carriesAnEditField(body)).toBe(true);
      expect(MessageUpdateRequestSchema.safeParse(body).success).toBe(true);
    }
  });

  test("content is no longer required, but a present content is still checked", () => {
    expect(MessageUpdateRequestSchema.safeParse({ tags: [] }).success).toBe(true);
    expect(MessageUpdateRequestSchema.safeParse({ content: { text: "x" } }).success).toBe(false);
  });

  test("cover must be a LocalId", () => {
    expect(MessageUpdateRequestSchema.safeParse({ cover: "not a local id!" }).success).toBe(false);
    expect(MessageUpdateRequestSchema.safeParse({ cover: "" }).success).toBe(false);
  });

  test("the WS command still requires its target ids", () => {
    const { messageId: _omit, ...noMessage } = wsUpdate({ tags: [] }).data;
    const frame = { id: "cli_1", type: "message.update", ts: TS, data: noMessage };
    expect(WsMessageUpdateSchema.safeParse(frame).success).toBe(false);
  });
});

describe("article fields and mentions on messages (§5.3)", () => {
  test("title/summary/cover/mentions are typed on Message and MessageCreate", () => {
    const base = {
      id: "msg_1",
      author: "jane@a.com",
      type: "article",
      content: { text: "body", mime: "text/markdown" },
      attachments: [],
      createdAt: TS,
      metadata: [],
    };
    expect(MessageSchema.safeParse({ ...base, cover: "bad cover!" }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...base, title: 7 }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...base, mentions: ["not a ref"] }).success).toBe(false);
    const create = { content: base.content, type: "article", title: "T", mentions: ["bob@b.com"] };
    expect(MessageCreateRequestSchema.safeParse(create).success).toBe(true);
  });
});

describe("Attachment thumbnail + expiresAt (§5.8)", () => {
  const video = { id: "att_7", mime: "video/mp4", url: "https://cdn.a.com/m/x/v.mp4", size: 1 };
  const poster = { id: "att_8", mime: "image/jpeg", url: "https://cdn.a.com/m/y/p.jpg", size: 1 };

  test("a thumbnail and an expiresAt parse", () => {
    expect(AttachmentSchema.safeParse({ ...video, thumbnail: poster, expiresAt: TS }).success).toBe(
      true,
    );
  });

  test("a thumbnail must not itself carry a thumbnail", () => {
    const nested = { ...video, thumbnail: { ...poster, thumbnail: poster } };
    expect(AttachmentSchema.safeParse(nested).success).toBe(false);
  });

  test("a thumbnail is itself a full attachment", () => {
    const { url: _omit, ...noUrl } = poster;
    expect(AttachmentSchema.safeParse({ ...video, thumbnail: noUrl }).success).toBe(false);
  });
});

describe("my groups (§5.7) and Group.membership (§5.5)", () => {
  const pointer = { group: "https://b.com/api/groups/grp_9", updatedAt: TS };

  test("a group pointer must name an https group URI", () => {
    const bad = { groups: [{ ...pointer, group: "grp_9" }], metadata: [] };
    expect(GroupPointersResponseSchema.safeParse(bad).success).toBe(false);
    const ok = { groups: [pointer], metadata: [] };
    expect(GroupPointersResponseSchema.safeParse(ok).success).toBe(true);
  });

  test("groups.updated must carry at least one added, changed or removed group", () => {
    const frame = (data: unknown) => ({ id: "evt_1", type: "groups.updated", ts: TS, data });
    expect(WsGroupsUpdatedSchema.safeParse(frame({ groups: [], removed: [] })).success).toBe(false);
    expect(WsGroupsUpdatedSchema.safeParse(frame({ groups: [pointer], removed: [] })).success).toBe(
      true,
    );
    expect(
      WsGroupsUpdatedSchema.safeParse(frame({ groups: [], removed: [pointer.group] })).success,
    ).toBe(true);
    expect(WsGroupsUpdatedSchema.safeParse(frame({ groups: [] })).success).toBe(false);
  });

  test("Group.membership is optional, and needs role + joinedAt when present", () => {
    const group = {
      id: "grp_1",
      name: "G",
      owner: "jane@a.com",
      joinPolicy: "open",
      tier: "public",
      permissions: {},
      createdAt: TS,
      updatedAt: TS,
      metadata: [],
    };
    expect(GroupSchema.safeParse(group).success).toBe(true);
    const member = { ...group, membership: { role: "member", joinedAt: TS } };
    expect(GroupSchema.safeParse(member).success).toBe(true);
    const partial = { ...group, membership: { role: "member" } };
    expect(GroupSchema.safeParse(partial).success).toBe(false);
  });

  test("groups.updated is a known WS type", () => {
    expect(isKnownWsType("groups.updated")).toBe(true);
  });
});
