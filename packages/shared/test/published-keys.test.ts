/**
 * Published vs submitted keys (§4.3.2, §4.3.3): published entries (keys
 * response, discovery) are only strings in the schemas and judged one by one
 * by `isUsablePublishedKey`; submitted keys (device-key registration, guest
 * creation) stay strictly validated by their schemas.
 */
import { describe, expect, test } from "bun:test";

import { findUsablePublishedKey, generateKeyPair, isUsablePublishedKey } from "../src/index.ts";
import {
  DeviceKeyRegistrationSchema,
  GuestCreateRequestSchema,
  ProviderDiscoverySchema,
  UserKeysResponseSchema,
} from "../src/schemas/index.ts";

const good = generateKeyPair().publicKey;
const b64 = (n: number) => Buffer.from(new Uint8Array(n).fill(3)).toString("base64");

describe("isUsablePublishedKey", () => {
  test("Ed25519 + a raw 32-byte padded base64 key is usable", () => {
    expect(isUsablePublishedKey({ algorithm: "Ed25519", public_key: good })).toBe(true);
  });

  test("a key that is not the raw 32-byte form is unusable", () => {
    for (const public_key of [b64(16), b64(33), good.replace(/=$/, ""), "", "%%%"]) {
      expect(isUsablePublishedKey({ algorithm: "Ed25519", public_key })).toBe(false);
    }
  });

  test("any algorithm other than exactly `Ed25519` is unusable", () => {
    for (const algorithm of ["Ed448", "ed25519", "ED25519", ""]) {
      expect(isUsablePublishedKey({ algorithm, public_key: good })).toBe(false);
    }
  });
});

describe("findUsablePublishedKey", () => {
  const usable = { key_id: "k1", algorithm: "Ed25519", public_key: good };
  const unusable = { key_id: "k1", algorithm: "Ed25519", public_key: b64(16) };

  test("an ignored entry counts as absent", () => {
    expect(findUsablePublishedKey([unusable], "k1")).toBeNull();
    expect(findUsablePublishedKey([usable], "k2")).toBeNull();
  });

  test("an ignored entry never hides a usable one under the same id", () => {
    expect(findUsablePublishedKey([unusable, usable], "k1")).toBe(usable);
  });
});

describe("published-key schemas take any string (the document stays valid)", () => {
  const entry = { key_id: "k_future", algorithm: "Ed448", public_key: b64(57) };

  test("a keys response holding an unusable entry parses", () => {
    const doc = {
      actor: "alice@a.test",
      keys: [
        entry,
        {
          key_id: "k1",
          algorithm: "Ed25519",
          public_key: good,
          created_at: "2026-01-01T00:00:00Z",
        },
      ].map((k) => ({ created_at: "2026-01-01T00:00:00Z", ...k })),
      cache_until: "2026-01-01T01:00:00Z",
    };
    expect(UserKeysResponseSchema.safeParse(doc).success).toBe(true);
  });

  test("a non-string `public_key` or `algorithm` still invalidates the document", () => {
    const base = { actor: "alice@a.test", cache_until: "2026-01-01T01:00:00Z" };
    const created_at = "2026-01-01T00:00:00Z";
    for (const bad of [
      { key_id: "k1", algorithm: "Ed25519", public_key: 42, created_at },
      { key_id: "k1", algorithm: null, public_key: good, created_at },
    ]) {
      expect(UserKeysResponseSchema.safeParse({ ...base, keys: [bad] }).success).toBe(false);
    }
  });

  test("a discovery document holding an unusable provider key parses", async () => {
    const sample = (await Bun.file(
      new URL("../../../../ofscp/tests/provider-discovery.sample.json", import.meta.url),
    ).json()) as { provider: { publicKeys: unknown[] } };
    sample.provider.publicKeys = [entry, ...sample.provider.publicKeys];
    expect(ProviderDiscoverySchema.safeParse(sample).success).toBe(true);
  });
});

describe("submitted keys stay strict (400 on the wire)", () => {
  for (const [name, public_key] of [
    ["16 bytes", b64(16)],
    ["33 bytes", b64(33)],
    ["unpadded", good.replace(/=$/, "")],
  ] as const) {
    test(`device-key registration and guest creation reject a ${name} key`, () => {
      expect(DeviceKeyRegistrationSchema.safeParse({ public_key, device_name: "d" }).success).toBe(
        false,
      );
      expect(GuestCreateRequestSchema.safeParse({ public_key, device_name: "d" }).success).toBe(
        false,
      );
    });
  }

  test("and an algorithm other than Ed25519", () => {
    const body = { public_key: good, device_name: "d", algorithm: "Ed448" };
    expect(DeviceKeyRegistrationSchema.safeParse(body).success).toBe(false);
    expect(GuestCreateRequestSchema.safeParse(body).success).toBe(false);
  });
});
