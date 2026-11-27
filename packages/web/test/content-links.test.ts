/**
 * The §5.3 link allow-list and the §5.8 attachment URL guard.
 */
import { describe, expect, test } from "bun:test";
import { attachmentFileUrl, linkTarget } from "../src/lib/content/links.ts";

describe("linkTarget", () => {
  test("http, https and mailto are active, case-insensitively", () => {
    expect(linkTarget("https://e.com/x")).toEqual({ kind: "url", href: "https://e.com/x" });
    expect(linkTarget("HTTP://e.com")).toEqual({ kind: "url", href: "http://e.com/" });
    expect(linkTarget("mailto:a@e.com")).toEqual({ kind: "url", href: "mailto:a@e.com" });
  });

  test("attachment: names an attachment id", () => {
    expect(linkTarget("attachment:att_1")).toEqual({ kind: "attachment", id: "att_1" });
    expect(linkTarget("attachment:")).toBeNull();
  });

  test("every other scheme is inactive", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc",
      "blob:https://e.com/1",
      "tel:1",
      "ftp://e.com",
    ]) {
      expect(linkTarget(href)).toBeNull();
    }
  });

  test("scheme-less and relative references are inactive", () => {
    for (const href of ["/foo", "#x", "//e.com", "page.html", "./a", "../a", "", "?q=1"]) {
      expect(linkTarget(href)).toBeNull();
    }
  });

  test("the URL standard's normalization runs before the check: no scheme bypass", () => {
    expect(linkTarget(" \tjavascript:alert(1)")).toBeNull();
    expect(linkTarget("java\tscript:alert(1)")).toBeNull();
    expect(linkTarget("java\nscript:alert(1)")).toBeNull();
    expect(linkTarget("\u0000javascript:alert(1)\u001f")).toBeNull();
    // A control character inside the scheme is NOT removed: no scheme at all.
    expect(linkTarget("java\u0001script:alert(1)")).toBeNull();
  });

  test("only leading/trailing C0-or-space is trimmed and only tab/newline removed inside", () => {
    expect(linkTarget(" \u0001https://e.com/x\u0000 ")).toEqual({
      kind: "url",
      href: "https://e.com/x",
    });
    expect(linkTarget("https://e.com/a\tb\nc\rd")).toEqual({
      kind: "url",
      href: "https://e.com/abcd",
    });
    // Any other control or a space in the middle stays (percent-encoded by the
    // serializer), rather than being dropped to join the two halves.
    expect(linkTarget("https://e.com/a\u0001b")).toEqual({
      kind: "url",
      href: "https://e.com/a%01b",
    });
    expect(linkTarget("https://e.com/a b")).toEqual({ kind: "url", href: "https://e.com/a%20b" });
  });

  test("a space before an @ never makes a working link to the host after it", () => {
    // Its URL host is evil.com (userinfo "good.com "): credentials → inactive.
    expect(linkTarget("https://good.com @evil.com")).toBeNull();
    expect(linkTarget("https://good.com\u0001@evil.com")).toBeNull();
    expect(linkTarget("https://good.com\t@evil.com")).toBeNull();
    expect(linkTarget("https://user:pw@e.com/")).toBeNull();
    // After the path starts, the `@` is just path text: the host stays good.com.
    expect(linkTarget("https://good.com/ @evil.com")).toEqual({
      kind: "url",
      href: "https://good.com/%20@evil.com",
    });
  });

  test("a destination that does not parse is inactive", () => {
    expect(linkTarget("https://")).toBeNull();
    expect(linkTarget("https://a\u0001b.com/")).toBeNull();
    expect(linkTarget("http://[::1")).toBeNull();
  });

  test("the href is the URL's serialization: what was checked is what navigates", () => {
    expect(linkTarget("HTTPS://E.com")).toEqual({ kind: "url", href: "https://e.com/" });
    expect(linkTarget("mailto:a@e.com")).toEqual({ kind: "url", href: "mailto:a@e.com" });
  });
});

describe("attachmentFileUrl (§5.8: never put fetched bytes on the client's origin)", () => {
  test("http and https URLs are used", () => {
    expect(attachmentFileUrl("https://cdn.e.com/m/1/a.png")).toBe("https://cdn.e.com/m/1/a.png");
    expect(attachmentFileUrl("http://localhost:3000/media/1")).toBe(
      "http://localhost:3000/media/1",
    );
  });

  test("blob:, data:, javascript: and relative URLs are refused", () => {
    for (const url of [
      "blob:https://app.e.com/5b1c",
      "data:text/html,<script>alert(1)</script>",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "javascript:alert(1)",
      "/media/1",
      "java\u0001script:alert(1)",
      "\tjava\nscript:alert(1)",
      "https://cdn.e.com @evil.com/a.png",
    ]) {
      expect(attachmentFileUrl(url)).toBeNull();
    }
  });

  test("normalized and serialized like a link destination", () => {
    expect(attachmentFileUrl(" https://cdn.e.com/m/\t1 ")).toBe("https://cdn.e.com/m/1");
  });
});
