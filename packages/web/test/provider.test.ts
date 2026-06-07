import { afterEach, describe, expect, test } from "bun:test";
import { defaultProviderHost } from "../src/lib/provider.ts";

// `defaultProviderHost()` reads `import.meta.env.VITE_PROVIDER_HOST` (Vite inlines
// it at build time; here it's read dynamically) and falls back to the origin.
// `import.meta.env` is readonly in source — cast to a mutable view to drive cases.
const env = import.meta.env as Record<string, string | undefined>;

describe("defaultProviderHost", () => {
  const original = env.VITE_PROVIDER_HOST;
  afterEach(() => {
    env.VITE_PROVIDER_HOST = original;
  });

  test("returns VITE_PROVIDER_HOST when set (separately-hosted client)", () => {
    env.VITE_PROVIDER_HOST = "providera.com";
    expect(defaultProviderHost()).toBe("providera.com");
  });

  test("ignores an empty VITE_PROVIDER_HOST and falls back to the origin", () => {
    env.VITE_PROVIDER_HOST = "";
    // No `location` in the Bun runtime → empty-string origin fallback.
    const expected = typeof location !== "undefined" ? location.host : "";
    expect(defaultProviderHost()).toBe(expected);
  });
});
