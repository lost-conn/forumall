/**
 * Key-store unit tests. The in-memory backend (the fallback used in tests / SSR
 * / when IndexedDB is unavailable) must satisfy the full `KeyStore` contract.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPair } from "@forumall/shared";
import { MemoryKeyStore, createKeyStore } from "../src/lib/key-store.ts";

describe("MemoryKeyStore", () => {
  test("set/get/list/remove/clear round-trip", async () => {
    const store = new MemoryKeyStore();
    const a = generateKeyPair();
    const b = generateKeyPair();

    expect(await store.getKey("key_a")).toBeNull();

    await store.setKey("key_a", a.privateKey);
    await store.setKey("key_b", b.privateKey);

    expect(await store.getKey("key_a")).toBe(a.privateKey);
    expect((await store.listKeyIds()).sort()).toEqual(["key_a", "key_b"]);
    expect((await store.list()).length).toBe(2);

    await store.remove("key_a");
    expect(await store.getKey("key_a")).toBeNull();
    expect(await store.listKeyIds()).toEqual(["key_b"]);

    await store.clear();
    expect(await store.listKeyIds()).toEqual([]);
  });
});

describe("createKeyStore", () => {
  test("falls back to in-memory when IndexedDB is unavailable", () => {
    // bun:test has no IndexedDB → the factory must not throw and must work.
    expect(typeof indexedDB).toBe("undefined");
    const store = createKeyStore();
    expect(store).toBeInstanceOf(MemoryKeyStore);
  });
});
