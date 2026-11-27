/**
 * The three WS envelope variants of §7.1 (ofscp#27): the base envelope, the
 * client→server command envelope (`ts` optional and ignored, `data` an object)
 * and the server→client event envelope (`ts` required). Inline vectors, so
 * these hold whatever ofscp revision the sibling checkout is at; the ofscp
 * samples and reject cases are checked in schemas.test.ts.
 */
import { describe, expect, test } from "bun:test";

import {
  WsCommandEnvelopeSchema,
  WsEnvelopeSchema,
  WsErrorSchema,
  WsEventEnvelopeSchema,
  WsPingSchema,
  WsPongSchema,
  WsSubscribeSchema,
  WsSubscribedSchema,
  WsTypingStopSchema,
} from "../src/schemas/index.ts";

const TS = "2026-01-01T12:00:00Z";

describe("command envelope: `ts` is optional and its value ignored", () => {
  const subscribe = { id: "cli_001", type: "subscribe", data: { channels: ["chn_general"] } };

  test("a command without `ts` parses", () => {
    expect(WsSubscribeSchema.safeParse(subscribe).success).toBe(true);
    expect(WsCommandEnvelopeSchema.safeParse(subscribe).success).toBe(true);
  });

  test("a command whose `ts` is not a timestamp still parses", () => {
    const stop = { id: "cli_002", type: "typing.stop", data: { channelId: "chn_general" } };
    for (const ts of ["not a timestamp", 42, null]) {
      expect(WsTypingStopSchema.safeParse({ ...stop, ts }).success).toBe(true);
    }
  });

  test("a command without `id` is rejected", () => {
    const { id: _id, ...noId } = subscribe;
    expect(WsSubscribeSchema.safeParse(noId).success).toBe(false);
    expect(WsCommandEnvelopeSchema.safeParse(noId).success).toBe(false);
  });

  test("a command whose `data` is not an object is rejected", () => {
    for (const data of [null, [], "x", 1]) {
      expect(WsCommandEnvelopeSchema.safeParse({ ...subscribe, data }).success).toBe(false);
    }
  });
});

describe("event envelope: `ts` is a required RFC 3339 timestamp", () => {
  const subscribed = {
    id: "evt_100",
    type: "subscribed",
    correlationId: "cli_001",
    ts: TS,
    data: { channels: ["chn_general"] },
  };

  test("an event with `ts` parses", () => {
    expect(WsSubscribedSchema.safeParse(subscribed).success).toBe(true);
    expect(WsEventEnvelopeSchema.safeParse(subscribed).success).toBe(true);
  });

  test("an event without `ts`, or with a malformed one, is rejected", () => {
    const { ts: _ts, ...noTs } = subscribed;
    expect(WsSubscribedSchema.safeParse(noTs).success).toBe(false);
    expect(WsEventEnvelopeSchema.safeParse(noTs).success).toBe(false);
    expect(WsErrorSchema.safeParse({ ...subscribed, ts: "yesterday" }).success).toBe(false);
  });
});

describe("base envelope and heartbeats", () => {
  test("`data` is required on every frame", () => {
    expect(WsEnvelopeSchema.safeParse({ id: "x", type: "some.future.event" }).success).toBe(false);
    expect(
      WsEnvelopeSchema.safeParse({ id: "x", type: "some.future.event", data: null }).success,
    ).toBe(true);
  });

  test("ping/pong use the base envelope: `ts` optional, `data` an object", () => {
    expect(WsPingSchema.safeParse({ id: "cli_400", type: "ping", data: {} }).success).toBe(true);
    expect(
      WsPongSchema.safeParse({
        id: "evt_1",
        type: "pong",
        ts: TS,
        correlationId: "cli_400",
        data: {},
      }).success,
    ).toBe(true);
    for (const data of [null, undefined, [], "x"]) {
      expect(WsPingSchema.safeParse({ id: "cli_400", type: "ping", data }).success).toBe(false);
    }
  });
});
