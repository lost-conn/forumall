/**
 * The §5.3 link allow-list and the §5.8 attachment URL guard.
 */
import { describe, expect, test } from "bun:test";
import { attachmentFileUrl, linkTarget } from "../src/lib/content/links.ts";

describe("linkTarget", () => {
  test("http, https and mailto are active, case-insensitively", () => {
    expect(linkTarget("https://e.com/x")).toEqual({ kind: "url", href: "https://e.com/x" });
    expect(linkTarget("HTTP://e.com")).toEqual({ kind: "url", href: "HTTP://e.com" });
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

  test("control characters and whitespace are stripped before the check, and from the result", () => {
    expect(linkTarget("java\u0001script:alert(1)")).toBeNull();
    expect(linkTarget(" \tjavascript:alert(1)")).toBeNull();
    expect(linkTarget("https://e.com/a\u0001b")).toEqual({ kind: "url", href: "https://e.com/ab" });
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
    ]) {
      expect(attachmentFileUrl(url)).toBeNull();
    }
  });
});
