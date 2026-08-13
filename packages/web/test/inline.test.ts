/**
 * Inline message-formatter unit tests: proves chat/DM bodies parse into the
 * expected node tree (bold/italic/code/links) with `@mentions` spliced in and
 * kept clickable even when nested inside a mark, and that unsafe link schemes
 * degrade to their plain label.
 */
import { describe, expect, test } from "bun:test";
import { type InlineNode, parseInline } from "../src/lib/inline.ts";

const DOMAIN = "example.com";
const parse = (text: string): InlineNode[] => parseInline(text, DOMAIN);

describe("parseInline — marks", () => {
  test("plain text is a single text node", () => {
    expect(parse("hello world")).toEqual([{ type: "text", value: "hello world" }]);
  });

  test("bold", () => {
    expect(parse("**b**")).toEqual([{ type: "strong", children: [{ type: "text", value: "b" }] }]);
  });

  test("italic with * and _", () => {
    expect(parse("*i*")).toEqual([{ type: "em", children: [{ type: "text", value: "i" }] }]);
    expect(parse("_i_")).toEqual([{ type: "em", children: [{ type: "text", value: "i" }] }]);
  });

  test("inline code is literal — inner marks are NOT parsed", () => {
    expect(parse("`**x**`")).toEqual([{ type: "code", value: "**x**" }]);
  });

  test("mixed marks with surrounding text", () => {
    expect(parse("a **b** c _d_")).toEqual([
      { type: "text", value: "a " },
      { type: "strong", children: [{ type: "text", value: "b" }] },
      { type: "text", value: " c " },
      { type: "em", children: [{ type: "text", value: "d" }] },
    ]);
  });
});

describe("parseInline — links", () => {
  test("safe link keeps its href and formatted label", () => {
    expect(parse("[site](https://example.com)")).toEqual([
      {
        type: "link",
        href: "https://example.com",
        children: [{ type: "text", value: "site" }],
      },
    ]);
  });

  test("unsafe scheme collapses to the plain label", () => {
    expect(parse("[x](javascript:evil)")).toEqual([{ type: "text", value: "x" }]);
  });
});

describe("parseInline — mentions", () => {
  test("bare mention resolves to local domain", () => {
    expect(parse("@alice")).toEqual([{ type: "mention", raw: "@alice", actor: `alice@${DOMAIN}` }]);
  });

  test("mention stays clickable when nested inside bold", () => {
    expect(parse("**@alice**")).toEqual([
      {
        type: "strong",
        children: [{ type: "mention", raw: "@alice", actor: `alice@${DOMAIN}` }],
      },
    ]);
  });

  test("an email is not a mention", () => {
    expect(parse("a@b.com")).toEqual([{ type: "text", value: "a@b.com" }]);
  });
});
