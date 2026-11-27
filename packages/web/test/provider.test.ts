import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPair } from "@forumall/shared";
import { defaultProviderHost, probeProvider } from "../src/lib/provider.ts";

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

describe("probeProvider registration mode (§4.1.1)", () => {
  const doc = (registration?: string) => ({
    provider: {
      domain: "a.example",
      protocolVersion: "0.1.0",
      software: { name: "forumall", version: "1.0.0" },
      contact: "admin@a.example",
      authentication: {
        login_endpoint: "https://a.example/api/auth/login",
        ...(registration ? { registration } : {}),
      },
      publicKeys: [
        {
          key_id: "pk_1",
          algorithm: "Ed25519",
          public_key: generateKeyPair().publicKey,
        },
      ],
    },
    capabilities: {},
  });
  const probe = (body: unknown) =>
    probeProvider(
      "a.example",
      (async () =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );

  test("reports the advertised mode", async () => {
    expect((await probe(doc("invite"))).registration).toBe("invite");
    expect((await probe(doc("closed"))).registration).toBe("closed");
  });

  test("an absent or unknown mode is open, and the document still validates", async () => {
    expect((await probe(doc())).registration).toBe("open");
    expect((await probe(doc("waitlist"))).registration).toBe("open");
  });
});
