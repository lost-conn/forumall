/**
 * Read-marker schemas (OFSCP §7.7): the zod mirror of `read-markers-response.json`,
 * `read-markers-update-request.json` and `ws/read-updated.json`. The request names
 * the newest message read (`lastReadMessageId`); there is no seq form.
 */
import { describe, expect, test } from "bun:test";

import {
  ReadMarkerSchema,
  ReadMarkersResponseSchema,
  ReadMarkersUpdateRequestSchema,
  ReadUpdatedEventSchema,
  WsReadUpdatedSchema,
  isKnownWsType,
} from "../src/schemas/index.ts";

describe("read-markers schemas (§7.7)", () => {
  test("a read-marker summary entry parses, with and without a marker", () => {
    expect(
      ReadMarkerSchema.safeParse({ scopeId: "chn_a", lastReadMessageId: "msg_7", unreadCount: 2 })
        .success,
    ).toBe(true);
    expect(ReadMarkerSchema.safeParse({ scopeId: "chn_a", unreadCount: 2 }).success).toBe(true);
  });

  test("the GET response (summary) parses and preserves unknown keys (§2.3)", () => {
    const r = ReadMarkersResponseSchema.safeParse({
      scopes: [{ scopeId: "chn_a", unreadCount: 3, groupId: "grp_1", future: "x" }],
      extra: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).extra).toBe(1);
    }
  });

  test("the PATCH request is markers of { scopeId, lastReadMessageId }, at least one", () => {
    expect(ReadMarkersUpdateRequestSchema.safeParse({ markers: [] }).success).toBe(false);
    expect(
      ReadMarkersUpdateRequestSchema.safeParse({
        markers: [{ scopeId: "chn_a", lastReadMessageId: "msg_5" }],
      }).success,
    ).toBe(true);
  });

  test("a marker without lastReadMessageId is rejected (no seq form)", () => {
    expect(
      ReadMarkersUpdateRequestSchema.safeParse({ markers: [{ scopeId: "chn_a", lastReadSeq: 5 }] })
        .success,
    ).toBe(false);
    expect(
      ReadMarkersUpdateRequestSchema.safeParse({ scopeId: "chn_a", lastReadSeq: 5 }).success,
    ).toBe(false);
  });

  test("lastReadMessageId must be a LocalId", () => {
    expect(
      ReadMarkersUpdateRequestSchema.safeParse({
        markers: [{ scopeId: "chn_a", lastReadMessageId: "not a/local id" }],
      }).success,
    ).toBe(false);
    expect(
      ReadMarkerSchema.safeParse({ scopeId: "chn_a", lastReadMessageId: "", unreadCount: 0 })
        .success,
    ).toBe(false);
  });

  test("a negative unreadCount is rejected", () => {
    expect(ReadMarkerSchema.safeParse({ scopeId: "chn_a", unreadCount: -1 }).success).toBe(false);
  });

  test("the read.updated event payload + WS frame parse", () => {
    const payload = { markers: [{ scopeId: "chn_a", lastReadMessageId: "msg_9", unreadCount: 0 }] };
    expect(ReadUpdatedEventSchema.safeParse(payload).success).toBe(true);
    const frame = WsReadUpdatedSchema.safeParse({
      id: "evt_1",
      type: "read.updated",
      ts: "2026-01-01T12:00:00Z",
      data: payload,
    });
    expect(frame.success).toBe(true);
  });

  test("read.updated is a known WS type", () => {
    expect(isKnownWsType("read.updated")).toBe(true);
  });
});
