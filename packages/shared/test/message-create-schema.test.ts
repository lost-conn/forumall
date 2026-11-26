/**
 * `MessageCreate` (ofscp#23, §7.1) and the full-`Message` events: the body
 * shared by `POST …/messages` and the WS `message.create` command, and the
 * `message.created` / `message.updated` / `dm.message` events that now carry the
 * canonical `BaseMessage`. Inline vectors, so these hold whatever ofscp revision
 * the sibling checkout is at; the ofscp samples are checked in schemas.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MessageCreateRequestSchema,
  MessageSchema,
  WsDmMessageSchema,
  WsMessageCreateSchema,
  WsMessageCreatedSchema,
  WsMessageUpdatedSchema,
} from "../src/schemas/index.ts";

const content = { mime: "text/plain", text: "hi" };
const attachment = {
  id: "att_1",
  mime: "image/png",
  url: "https://cdn.a.com/att_1.png",
  size: 20480,
  width: 1024,
  height: 768,
};
const fullMessage = {
  id: "msg_1",
  clientMessageId: "cmsg_1",
  author: "alice@a.com",
  type: "memo",
  content,
  attachments: [attachment],
  tags: ["#design"],
  createdAt: "2026-01-01T12:00:00Z",
  permissions: { editUntil: "2026-01-01T13:00:00Z" },
  metadata: [],
};
const envelope = (type: string, data: unknown) => ({
  id: "evt_1",
  type,
  ts: "2026-01-01T12:00:00Z",
  data,
});

describe("MessageCreateRequestSchema (§7.1 MessageCreate)", () => {
  test("only content is required; every optional field is accepted", () => {
    expect(MessageCreateRequestSchema.safeParse({ content }).success).toBe(true);
    const full = MessageCreateRequestSchema.parse({
      clientMessageId: "cmsg_1",
      type: "article",
      content,
      attachments: [attachment],
      reference: { type: "reply", id: "msg_0" },
      tags: ["#intro"],
      metadata: [{ schema: "https://x.example/meta/v1", version: "1", data: { a: 1 } }],
      futureField: true,
    });
    expect(full.type).toBe("article");
    expect((full as Record<string, unknown>).futureField).toBe(true);
  });

  test("rejects a body that does not match the schema", () => {
    const bad: Record<string, unknown>[] = [
      {},
      { content: { mime: "text/plain" } },
      { content, type: "poll" },
      { content, clientMessageId: "" },
      { content, attachments: {} },
      { content, attachments: [{ id: "att_1", mime: "image/png" }] },
      { content, attachments: [{ ...attachment, url: "http://cdn.a.com/x.png" }] },
      { content, reference: { type: "reply" } },
      { content, tags: ["#ok", 7] },
      { content, metadata: [{ schema: "x" }] },
    ];
    for (const body of bad) {
      expect({ body, ok: MessageCreateRequestSchema.safeParse(body).success }).toEqual({
        body,
        ok: false,
      });
    }
  });

  test("the §4.4.3 signing vector signs a valid create body", () => {
    const vectorPath = new URL("../../../../ofscp/tests/signing-vector.json", import.meta.url);
    const vector = JSON.parse(readFileSync(fileURLToPath(vectorPath), "utf8")) as {
      request: { method: string; path: string; body: string };
    };
    expect(vector.request.method).toBe("POST");
    expect(vector.request.path).toMatch(/^\/api\/groups\/[^/]+\/channels\/[^/]+\/messages$/);
    expect(MessageCreateRequestSchema.safeParse(JSON.parse(vector.request.body)).success).toBe(
      true,
    );
  });
});

describe("WsMessageCreateSchema (message.create = MessageCreate + target)", () => {
  test("carries every MessageCreate field beside groupId / channelId", () => {
    const frame = envelope("message.create", {
      groupId: "grp_1",
      channelId: "chn_1",
      clientMessageId: "cmsg_1",
      type: "memo",
      content,
      attachments: [attachment],
      reference: { type: "reply", id: "msg_0" },
      tags: ["#intro"],
      metadata: [],
    });
    const parsed = WsMessageCreateSchema.parse(frame);
    expect(parsed.data.attachments?.[0]?.width).toBe(1024);
    expect(parsed.data.reference?.id).toBe("msg_0");
  });

  test("requires the target and validates the body fields", () => {
    expect(WsMessageCreateSchema.safeParse(envelope("message.create", { content })).success).toBe(
      false,
    );
    const target = { groupId: "grp_1", channelId: "chn_1" };
    for (const extra of [{ type: "poll" }, { attachments: [{}] }, { tags: "x" }]) {
      const frame = envelope("message.create", { ...target, content, ...extra });
      expect(WsMessageCreateSchema.safeParse(frame).success).toBe(false);
    }
  });
});

describe("events carry the full Message (§7.1, §7.4)", () => {
  const compact = {
    id: "msg_1",
    clientMessageId: "cmsg_1",
    author: "alice@a.com",
    createdAt: "2026-01-01T12:00:00Z",
    content,
  };
  const channelData = (message: unknown) => ({
    groupId: "grp_1",
    channelId: "chn_1",
    cursor: "c1",
    message,
  });
  const dmData = (message: unknown) => ({
    dmId: `dm_${"a".repeat(64)}`,
    cursor: "c1",
    message,
  });

  test("message.created / message.updated / dm.message accept a full Message", () => {
    expect(
      WsMessageCreatedSchema.safeParse(envelope("message.created", channelData(fullMessage)))
        .success,
    ).toBe(true);
    const edited = { ...fullMessage, editedAt: "2026-01-01T12:05:00Z" };
    expect(
      WsMessageUpdatedSchema.safeParse(envelope("message.updated", channelData(edited))).success,
    ).toBe(true);
    expect(
      WsDmMessageSchema.safeParse(
        envelope("dm.message", dmData({ ...fullMessage, type: "message" })),
      ).success,
    ).toBe(true);
  });

  test("a duplicate-create answer may omit the cursor", () => {
    const { cursor: _cursor, ...noCursor } = channelData(fullMessage);
    expect(WsMessageCreatedSchema.safeParse(envelope("message.created", noCursor)).success).toBe(
      true,
    );
  });

  test("the pre-#23 compact message is rejected", () => {
    expect(
      WsMessageCreatedSchema.safeParse(envelope("message.created", channelData(compact))).success,
    ).toBe(false);
    expect(
      WsMessageUpdatedSchema.safeParse(envelope("message.updated", channelData(compact))).success,
    ).toBe(false);
    expect(WsDmMessageSchema.safeParse(envelope("dm.message", dmData(compact))).success).toBe(
      false,
    );
  });

  test("MessageSchema carries the clientMessageId echo (non-empty when present)", () => {
    expect(MessageSchema.parse(fullMessage).clientMessageId).toBe("cmsg_1");
    const { clientMessageId: _omit, ...without } = fullMessage;
    expect(MessageSchema.safeParse(without).success).toBe(true);
    expect(MessageSchema.safeParse({ ...fullMessage, clientMessageId: "" }).success).toBe(false);
  });
});
