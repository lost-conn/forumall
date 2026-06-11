import { describe, expect, test } from "bun:test";

import {
  PushPublicKeyResponseSchema,
  PushSubscribeRequestSchema,
  PushUnsubscribeRequestSchema,
} from "../src/schemas/push.ts";

describe("PushSubscribeRequestSchema", () => {
  const valid = {
    endpoint: "https://push.example.net/push/abc",
    keys: { p256dh: "BAAA…", auth: "BTBZ…" },
  };

  test("accepts a well-formed subscription", () => {
    expect(PushSubscribeRequestSchema.parse(valid)).toMatchObject(valid);
  });

  test("preserves unknown fields (passthrough, §2.3)", () => {
    const parsed = PushSubscribeRequestSchema.parse({ ...valid, expirationTime: null });
    expect((parsed as Record<string, unknown>).expirationTime).toBeNull();
  });

  test("rejects a non-URL endpoint", () => {
    expect(PushSubscribeRequestSchema.safeParse({ ...valid, endpoint: "not a url" }).success).toBe(
      false,
    );
  });

  test("rejects missing keys", () => {
    expect(PushSubscribeRequestSchema.safeParse({ endpoint: valid.endpoint }).success).toBe(false);
    expect(
      PushSubscribeRequestSchema.safeParse({
        endpoint: valid.endpoint,
        keys: { p256dh: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("PushUnsubscribeRequestSchema", () => {
  test("accepts an endpoint URL", () => {
    expect(
      PushUnsubscribeRequestSchema.parse({ endpoint: "https://push.example.net/x" }).endpoint,
    ).toBe("https://push.example.net/x");
  });

  test("rejects a non-URL endpoint", () => {
    expect(PushUnsubscribeRequestSchema.safeParse({ endpoint: "nope" }).success).toBe(false);
  });
});

describe("PushPublicKeyResponseSchema", () => {
  test("accepts a public key string", () => {
    expect(PushPublicKeyResponseSchema.parse({ publicKey: "BAAA" }).publicKey).toBe("BAAA");
  });

  test("rejects an empty key", () => {
    expect(PushPublicKeyResponseSchema.safeParse({ publicKey: "" }).success).toBe(false);
  });
});
