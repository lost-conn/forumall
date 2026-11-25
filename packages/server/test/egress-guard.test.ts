/**
 * Outbound egress guard (SSRF defence): which addresses are refused, that
 * names are judged by EVERY address they resolve to, that resolution failures
 * are transient (not refusals), and that one deadline covers DNS + fetch.
 */
import { describe, expect, test } from "bun:test";

import {
  EgressBlockedError,
  EgressResolutionError,
  assertPublicHttpsUrl,
  guardedFetch,
  isBlockedAddress,
} from "../src/provider/federation/egress-guard.ts";

describe("isBlockedAddress", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "2001:db8::1",
  ])("refuses %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  test.each(["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows public %s",
    (addr) => {
      expect(isBlockedAddress(addr)).toBe(false);
    },
  );

  test("refuses anything that is not an IP literal", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
  });
});

describe("assertPublicHttpsUrl", () => {
  const resolveTo = (addrs: string[]) => ({ resolve: async () => addrs });

  test("allows a public https host", async () => {
    await assertPublicHttpsUrl(
      "https://peer.example/.well-known/ofscp-provider",
      resolveTo(["93.184.216.34"]),
    );
  });

  test("refuses http", async () => {
    await expect(
      assertPublicHttpsUrl("http://peer.example/", resolveTo(["93.184.216.34"])),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  test("refuses an IP-literal internal host without resolving", async () => {
    await expect(
      assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data", {
        resolve: async () => {
          throw new Error("should not resolve");
        },
      }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(assertPublicHttpsUrl("https://[::1]:8443/", resolveTo([]))).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  test("refuses a name if ANY resolved address is internal", async () => {
    await expect(
      assertPublicHttpsUrl("https://rebind.example/", resolveTo(["93.184.216.34", "10.0.0.5"])),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  // §4.6: a name that fails to resolve is a network error (transient), not a
  // policy refusal — so it must NOT be an EgressBlockedError.
  test("a name that does not resolve is a transient resolution error, not a refusal", async () => {
    const err = await assertPublicHttpsUrl("https://nx.example/", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressResolutionError);
    expect(err).not.toBeInstanceOf(EgressBlockedError);
  });

  test("a name that resolves to no addresses is a resolution error", async () => {
    await expect(
      assertPublicHttpsUrl("https://empty.example/", resolveTo([])),
    ).rejects.toBeInstanceOf(EgressResolutionError);
  });

  test("a resolver that never settles is abandoned at the deadline", async () => {
    const started = performance.now();
    await expect(
      assertPublicHttpsUrl("https://hang.example/", {
        resolve: () => new Promise<string[]>(() => {}),
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toBeInstanceOf(EgressResolutionError);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("guardedFetch", () => {
  const ok = async () => new Response("ok");

  test("one deadline covers DNS: a hung resolver rejects within timeoutMs", async () => {
    let fetched = false;
    const started = performance.now();
    await expect(
      guardedFetch(new Request("https://hang.example/x"), {
        timeoutMs: 150,
        resolve: () => new Promise<string[]>(() => {}),
        fetch: async () => {
          fetched = true;
          return new Response("ok");
        },
      }),
    ).rejects.toBeInstanceOf(EgressResolutionError);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(fetched).toBe(false);
  });

  test("the same deadline bounds the request after a slow resolution", async () => {
    // DNS takes half the deadline; the request then hangs until aborted. With
    // ONE deadline the whole call ends at ~DEADLINE_MS. A fresh timeout started
    // after DNS would end no earlier than RESOLVE_MS + DEADLINE_MS, which is
    // the bound — leaving RESOLVE_MS (750 ms, ~5x the old margin) of headroom
    // for a loaded machine, and as much again for the resolver to win its race.
    const DEADLINE_MS = 1_500;
    const RESOLVE_MS = 750;
    let fetched = false;
    const started = performance.now();
    const err = await guardedFetch(new Request("https://slow.example/x"), {
      timeoutMs: DEADLINE_MS,
      resolve: () =>
        new Promise<string[]>((r) => setTimeout(() => r(["93.184.216.34"]), RESOLVE_MS)),
      // A fetch that only ends when its signal aborts.
      fetch: (_req, init) => {
        fetched = true;
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      },
    }).catch((e: unknown) => e);
    const elapsed = performance.now() - started;
    expect(err).toBeInstanceOf(Error);
    expect(fetched).toBe(true); // DNS finished in time: the REQUEST was what the deadline cut
    // Aborted by the ONE deadline — not a fresh full timeout after DNS.
    expect(elapsed).toBeLessThan(RESOLVE_MS + DEADLINE_MS);
  });

  test("passes redirect: manual and returns the response for a public host", async () => {
    let seen: RequestInit | undefined;
    const res = await guardedFetch(new Request("https://peer.example/x"), {
      resolve: async () => ["93.184.216.34"],
      fetch: async (_req, init) => {
        seen = init;
        return ok();
      },
    });
    expect(res.status).toBe(200);
    expect(seen?.redirect).toBe("manual");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a private resolved address is refused by policy before fetching", async () => {
    await expect(
      guardedFetch(new Request("https://internal.example/x"), {
        resolve: async () => ["10.0.0.7"],
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });
});
