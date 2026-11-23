/**
 * Outbound egress guard (SSRF defence): which addresses are refused, and that
 * names are judged by EVERY address they resolve to.
 */
import { describe, expect, test } from "bun:test";

import {
  EgressBlockedError,
  assertPublicHttpsUrl,
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
  const resolveTo = (addrs: string[]) => async () => addrs;

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
      assertPublicHttpsUrl("https://169.254.169.254/latest/meta-data", async () => {
        throw new Error("should not resolve");
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

  test("refuses a name that does not resolve", async () => {
    await expect(
      assertPublicHttpsUrl("https://nx.example/", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });
});
