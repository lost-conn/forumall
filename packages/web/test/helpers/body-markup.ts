/**
 * Test-only serializer for the message-body render tree, so body tests can
 * assert on a compact, readable string instead of deep node literals.
 *
 * Elements print as `<tag>…</tag>` (`<br>`/`<hr>` void), text with `&<>`
 * escaped, and the non-element nodes as pseudo-tags:
 * `<mention actor="…">raw</mention>`, `<a href="…">…</a>`,
 * `<att-link id="…">…</att-link>`, `<att id="…" caption="…">` and
 * `<remote-img href="…" alt="…">`.
 */
import type { BodyNode } from "../../src/lib/content/nodes.ts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function markup(nodes: readonly BodyNode[]): string {
  return nodes.map(one).join("");
}

function one(node: BodyNode): string {
  switch (node.kind) {
    case "text":
      return esc(node.value);
    case "mention":
      return `<mention actor="${esc(node.actor)}">${esc(node.raw)}</mention>`;
    case "link":
      return `<a href="${esc(node.href)}">${markup(node.children)}</a>`;
    case "attachment-link":
      return `<att-link id="${esc(node.id)}">${markup(node.children)}</att-link>`;
    case "attachment-embed":
      return `<att id="${esc(node.id)}" caption="${esc(node.caption)}">`;
    case "remote-image":
      return `<remote-img href="${esc(node.href)}" alt="${esc(node.alt)}">`;
    case "element": {
      if (node.tag === "br" || node.tag === "hr") return `<${node.tag}>`;
      const attrs = [
        node.start !== undefined ? ` start="${node.start}"` : "",
        node.colspan !== undefined ? ` colspan="${node.colspan}"` : "",
        node.rowspan !== undefined ? ` rowspan="${node.rowspan}"` : "",
      ].join("");
      return `<${node.tag}${attrs}>${markup(node.children)}</${node.tag}>`;
    }
  }
}
