/**
 * ArticleEditor — a lightweight, dependency-free WYSIWYG for `article`-type
 * messages (§5.3). Edits happen in a `contenteditable` surface with a small
 * formatting toolbar; on every change the DOM is serialized to **markdown** (the
 * wire format for articles, `text/markdown`), restricted to exactly the
 * vocabulary `lib/markdown.ts` renders so a save → reload round-trips.
 *
 * Editing an existing article: the markdown is rendered to HTML via the same
 * trusted `renderMarkdown` and loaded into the editor, then re-serialized.
 *
 * Toolbar uses `document.execCommand` — deprecated but universally supported in
 * the browsers we target, and it keeps the editor tiny (no ProseMirror/Tiptab
 * dependency, per the self-host "pure-JS, keep it lean" guidance).
 */
import { type Component, For, onMount } from "solid-js";
import { renderMarkdown } from "../../lib/markdown.ts";

/** Serialize a contenteditable root to markdown (the renderer's subset). */
export function serializeMarkdown(root: HTMLElement): string {
  const blocks: string[] = [];
  for (const node of Array.from(root.childNodes)) {
    const md = serializeBlock(node);
    if (md != null && md.trim() !== "") blocks.push(md);
  }
  return blocks.join("\n\n").trim();
}

const HEADING_PREFIX: Record<string, string> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  h4: "#### ",
  h5: "##### ",
  h6: "###### ",
};

function serializeBlock(node: Node): string | null {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const t = (node.textContent ?? "").trim();
    return t.length > 0 ? t : null;
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return null;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  if (tag in HEADING_PREFIX) return `${HEADING_PREFIX[tag]}${serializeInline(el)}`;
  if (tag === "blockquote") {
    return serializeInline(el)
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
  }
  if (tag === "ul") {
    return Array.from(el.children)
      .map((li) => `- ${serializeInline(li)}`)
      .join("\n");
  }
  if (tag === "ol") {
    return Array.from(el.children)
      .map((li, i) => `${i + 1}. ${serializeInline(li)}`)
      .join("\n");
  }
  if (tag === "pre") return `\`\`\`\n${el.textContent ?? ""}\n\`\`\``;
  if (tag === "br") return null;
  // p / div / anything else → a paragraph of inline content.
  const inline = serializeInline(el);
  return inline.trim().length > 0 ? inline : null;
}

function serializeInline(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += child.textContent ?? "";
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const inner = serializeInline(el);
    switch (tag) {
      case "strong":
      case "b":
        out += `**${inner}**`;
        break;
      case "em":
      case "i":
        out += `*${inner}*`;
        break;
      case "code":
        out += `\`${inner}\``;
        break;
      case "a":
        out += `[${inner}](${el.getAttribute("href") ?? ""})`;
        break;
      case "br":
        out += "\n";
        break;
      default:
        out += inner;
    }
  }
  return out;
}

interface ToolbarButton {
  label: string;
  title: string;
  run: (exec: (cmd: string, value?: string) => void) => void;
}

const TOOLBAR: ToolbarButton[] = [
  { label: "B", title: "Bold", run: (x) => x("bold") },
  { label: "I", title: "Italic", run: (x) => x("italic") },
  { label: "H1", title: "Heading 1", run: (x) => x("formatBlock", "<h1>") },
  { label: "H2", title: "Heading 2", run: (x) => x("formatBlock", "<h2>") },
  { label: "H3", title: "Heading 3", run: (x) => x("formatBlock", "<h3>") },
  { label: "❝", title: "Quote", run: (x) => x("formatBlock", "<blockquote>") },
  { label: "• List", title: "Bulleted list", run: (x) => x("insertUnorderedList") },
  { label: "1. List", title: "Numbered list", run: (x) => x("insertOrderedList") },
  { label: "¶", title: "Paragraph", run: (x) => x("formatBlock", "<p>") },
];

export const ArticleEditor: Component<{
  /** Initial markdown to edit (rendered into the surface on mount). */
  initial?: string;
  /** Called with the serialized markdown on every edit. */
  onChange: (markdown: string) => void;
  placeholder?: string;
}> = (props) => {
  let editor: HTMLDivElement | undefined;

  const emit = (): void => {
    if (editor) props.onChange(serializeMarkdown(editor));
  };

  const exec = (cmd: string, value?: string): void => {
    editor?.focus();
    document.execCommand(cmd, false, value);
    emit();
  };

  const link = (): void => {
    const url = prompt("Link URL (https://…)");
    if (url) exec("createLink", url);
  };

  onMount(() => {
    if (editor && props.initial && props.initial.trim().length > 0) {
      // `renderMarkdown` is XSS-safe (escapes input, allowlists link schemes).
      editor.innerHTML = renderMarkdown(props.initial);
    }
    emit();
  });

  return (
    <div class="rounded-lg border border-border bg-surface" data-testid="article-editor">
      <div class="flex flex-wrap gap-0.5 border-b border-border p-1">
        <For each={TOOLBAR}>
          {(b) => (
            <button
              type="button"
              class="rounded px-2 py-1 text-xs font-medium text-muted hover:(bg-surface-2 text-ink)"
              title={b.title}
              data-testid="article-toolbar-btn"
              // Keep selection: prevent the button from stealing focus.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => b.run(exec)}
            >
              {b.label}
            </button>
          )}
        </For>
        <button
          type="button"
          class="rounded px-2 py-1 text-xs font-medium text-muted hover:(bg-surface-2 text-ink)"
          title="Link"
          data-testid="article-toolbar-link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={link}
        >
          🔗
        </button>
      </div>
      {/* biome-ignore lint/a11y/useFocusableInteractive: a contenteditable element is natively focusable. */}
      <div
        ref={editor}
        contenteditable
        role="textbox"
        tabindex="0"
        aria-multiline="true"
        data-testid="article-input"
        data-placeholder={props.placeholder ?? "Write an article…"}
        class="prose-chat min-h-40 max-h-96 overflow-auto px-3 py-2 text-sm text-ink outline-none"
        onInput={emit}
      />
    </div>
  );
};
