/**
 * ArticleEditorOverlay (§5.3) — the dedicated, full-screen article editor opened
 * from the channel composer's "Article" tab (matches screenshot 04 / editor.jsx).
 * A Markdown canvas with Write/Preview, a formatting toolbar, and a publish side
 * panel (target channel + tags). Publishing emits the assembled markdown
 * (`# <title>` + body) and tags to the caller, which posts an `article` message.
 */
import { type Component, For, Show, createSignal } from "solid-js";
import { renderMarkdown } from "../../lib/markdown.ts";
import { Icon, type IconName } from "../Icon.tsx";

interface ToolItem {
  label?: string;
  icon?: IconName;
  /** Wrap the selection / insert at the caret. */
  wrap?: [string, string];
  prefix?: string;
  sep?: boolean;
}

const TOOLBAR: ToolItem[] = [
  { label: "H", prefix: "## " },
  { label: "B", wrap: ["**", "**"] },
  { label: "I", wrap: ["*", "*"] },
  { sep: true },
  { icon: "more", prefix: "- " },
  { icon: "reply", prefix: "> " },
  { icon: "code", wrap: ["`", "`"] },
  { sep: true },
  { icon: "link", wrap: ["[", "](https://)"] },
  { icon: "image", wrap: ["![", "](https://)"] },
];

export const ArticleEditorOverlay: Component<{
  channelName: string;
  initialTitle?: string;
  initialBody?: string;
  promotedFrom?: string | null;
  onClose: () => void;
  onPublish: (args: { title: string; body: string; tags: string[] }) => void;
}> = (props) => {
  const [title, setTitle] = createSignal(props.initialTitle ?? "");
  const [body, setBody] = createSignal(props.initialBody ?? "");
  const [mode, setMode] = createSignal<"write" | "preview">("write");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagDraft, setTagDraft] = createSignal("");
  // Publish-setting toggles (visual; reactions/replies default on, pin off).
  const [allowReactions, setAllowReactions] = createSignal(true);
  const [allowReplies, setAllowReplies] = createSignal(true);
  const [pinToChannel, setPinToChannel] = createSignal(false);
  let textarea: HTMLTextAreaElement | undefined;

  const previewMarkdown = () =>
    `${title().trim() ? `# ${title().trim()}\n\n` : ""}${body()}` || "Nothing written yet.";

  const applyTool = (t: ToolItem): void => {
    const el = textarea;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const val = body();
    if (t.wrap) {
      const [a, b] = t.wrap;
      setBody(val.slice(0, start) + a + val.slice(start, end) + b + val.slice(end));
    } else if (t.prefix) {
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      setBody(val.slice(0, lineStart) + t.prefix + val.slice(lineStart));
    }
    el.focus();
  };

  const addTag = (): void => {
    const t = tagDraft().trim().toLowerCase();
    if (t && !tags().includes(t)) setTags((prev) => [...prev, t]);
    setTagDraft("");
  };

  const publish = (): void => {
    props.onPublish({ title: title().trim(), body: body().trim(), tags: tags() });
  };

  return (
    <div class="fixed inset-0 z-[90] flex flex-col bg-canvas" data-testid="article-editor-overlay">
      {/* Top bar */}
      <div class="flex items-center gap-3 border-b border-border px-[18px] py-[11px]">
        <button
          type="button"
          class="text-muted hover:text-ink"
          aria-label="Close editor"
          data-testid="article-editor-close"
          onClick={props.onClose}
        >
          <Icon name="x" size={18} />
        </button>
        <span class="fa-meta flex items-center gap-1.5">
          <Icon name="article" size={13} />#{props.channelName}
          <Icon name="chevRight" size={11} />
          <span class="text-ink">{title().trim() ? "Editing" : "New article"}</span>
        </span>
        <div class="ml-auto flex items-center gap-2">
          <div class="inline-flex overflow-hidden rounded-md border-[1.5px] border-border-strong">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[12px]"
              classList={{
                "bg-accent text-accent-ink": mode() === "write",
                "bg-surface text-muted": mode() !== "write",
              }}
              onClick={() => setMode("write")}
            >
              <Icon name="article" size={13} />
              Write
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 border-l-[1.5px] border-border-strong px-3 py-1.5 font-mono text-[12px]"
              classList={{
                "bg-accent text-accent-ink": mode() === "preview",
                "bg-surface text-muted": mode() !== "preview",
              }}
              onClick={() => setMode("preview")}
            >
              <Icon name="search" size={13} />
              Preview
            </button>
          </div>
          <button type="button" class="btn-ghost px-3 py-1.5 text-xs" onClick={props.onClose}>
            Save draft
          </button>
          <button
            type="button"
            class="btn-accent px-4 py-1.5 text-xs"
            data-testid="article-editor-publish"
            onClick={publish}
          >
            <Icon name="send" size={14} />
            Publish
          </button>
        </div>
      </div>

      <div class="flex min-h-0 flex-1">
        {/* Canvas */}
        <div class="min-h-0 flex-1 overflow-auto px-6 py-6 fa-scroll">
          <div class="mx-auto max-w-3xl">
            <Show
              when={mode() === "write"}
              fallback={
                <div
                  class="prose-chat text-sm text-ink"
                  data-testid="article-editor-preview"
                  innerHTML={renderMarkdown(previewMarkdown())}
                />
              }
            >
              <input
                class="w-full bg-transparent font-display text-3xl font-bold tracking-tight text-ink outline-none placeholder:text-faint"
                data-testid="article-editor-title"
                placeholder="Article title…"
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
              />
              <div class="my-4 flex flex-wrap items-center gap-1.5 border-y border-border py-2">
                <For each={TOOLBAR}>
                  {(t) => (
                    <Show
                      when={!t.sep}
                      fallback={<span class="mx-1 h-5 w-px bg-border" aria-hidden="true" />}
                    >
                      <button
                        type="button"
                        class="grid h-8 min-w-8 place-items-center rounded-sm border-[1.5px] border-border-strong bg-surface px-1.5 font-mono text-sm text-ink hover:bg-accent-soft"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyTool(t)}
                      >
                        <Show when={t.icon} fallback={t.label}>
                          {(name) => <Icon name={name()} size={15} />}
                        </Show>
                      </button>
                    </Show>
                  )}
                </For>
                <span class="ml-auto inline-flex items-center gap-1.5 font-mono text-[12px] text-muted">
                  <Icon name="code" size={13} />
                  Markdown
                </span>
              </div>
              <textarea
                ref={textarea}
                class="min-h-80 w-full resize-y bg-transparent font-mono text-sm leading-relaxed text-ink outline-none placeholder:text-faint"
                data-testid="article-input"
                placeholder={
                  "Write in Markdown…\n\n## A heading\n\nExplain the thing. Drop in `code`, lists, and links."
                }
                value={body()}
                onInput={(e) => setBody(e.currentTarget.value)}
              />
            </Show>
          </div>
        </div>

        {/* Publish settings */}
        <div class="w-[244px] shrink-0 overflow-auto border-l border-border bg-surface px-[14px] py-4 fa-scroll">
          <div class="eyebrow mb-3">Publish settings</div>
          <Show when={props.promotedFrom}>
            {(from) => (
              <div class="mb-4 inline-flex items-center gap-1.5 rounded-sm border-[1.5px] border-dashed border-ember bg-ember-soft px-2 py-0.5 text-[11px] font-mono uppercase tracking-wide text-ember">
                <Icon name="hash" size={12} />
                from {from()}
              </div>
            )}
          </Show>
          <div class="fa-meta mb-1.5">Post to</div>
          <div class="mb-4 flex items-center gap-2 rounded-md border-[1.5px] border-border-strong bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink">
            <Icon name="article" size={14} />#{props.channelName}
          </div>
          <div class="fa-meta mb-1.5">Tags</div>
          <div class="mb-2 flex flex-wrap gap-1.5">
            <For each={tags()}>
              {(t) => (
                <button
                  type="button"
                  class="fa-tag fa-tag--ember"
                  onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                >
                  {t}
                  <Icon name="x" size={11} />
                </button>
              )}
            </For>
          </div>
          <input
            class="input mb-[18px] text-xs"
            data-testid="article-editor-tag"
            placeholder="Add a tag + Enter"
            value={tagDraft()}
            onInput={(e) => setTagDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
          />

          <SettingRow label="Allow reactions" on={allowReactions()} set={setAllowReactions} />
          <SettingRow label="Allow replies" on={allowReplies()} set={setAllowReplies} />
          <SettingRow label="Pin to channel" on={pinToChannel()} set={setPinToChannel} />
        </div>
      </div>
    </div>
  );
};

/** A dashed-divider toggle row mirroring the prototype's `.pr-setrow` + `.fa-switch`. */
const SettingRow: Component<{ label: string; on: boolean; set: (v: boolean) => void }> = (
  props,
) => (
  <div class="flex items-center gap-3 border-b border-dashed border-border py-3">
    <span class="flex-1 font-body text-[13.5px] text-ink">{props.label}</span>
    <button
      type="button"
      class="fa-switch"
      classList={{ "fa-switch--on": props.on }}
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={() => props.set(!props.on)}
    >
      <span class="fa-switch__knob" />
    </button>
  </div>
);
