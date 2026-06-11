/**
 * Shared, presentational reaction UI — used by BOTH channel chat
 * ({@link ../chat/ChatView}) and direct messages ({@link ../dms/DmsPage}).
 *
 * These are pure presentation + interaction: they take the aggregated reaction
 * groups, the set of keys the current user already holds, and callbacks
 * (`onToggle` / `onPick`). The container decides where the reactions live (which
 * store) and how a toggle is delivered (a WS command for channels, a signed REST
 * `PUT`/`DELETE` for DMs) — the components here never touch the store or the
 * network, so reusing them across surfaces can't regress either one.
 *
 * `ReactionGroup` is the same shape the chat store aggregates (`key` + optional
 * `unicode` + the list of authors); the DM store aggregates the identical shape
 * from the same canonical `Reaction` objects.
 */
import { type Component, For, Show, createSignal } from "solid-js";

/** A small, friendly reaction palette for the quick-react button. */
export const QUICK_REACTIONS: { key: string; unicode: string }[] = [
  { key: "+1", unicode: "👍" },
  { key: "heart", unicode: "❤️" },
  { key: "tada", unicode: "🎉" },
  { key: "eyes", unicode: "👀" },
  { key: "laugh", unicode: "😄" },
];

/** One aggregated reaction group (mirrors the chat/dm store's `ReactionGroup`). */
export interface ReactionGroupView {
  key: string;
  unicode?: string;
  image?: string;
  authors: string[];
}

/**
 * The quick-react button + its emoji popover. Emits `onPick(key, unicode)` for
 * the chosen emoji; the container toggles add/remove. Opens DOWNWARD so it stays
 * inside an `overflow-auto` message list (mirrors the chat picker).
 */
export const ReactionPicker: Component<{
  onPick: (key: string, unicode: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const pick = (key: string, unicode: string): void => {
    props.onPick(key, unicode);
    setOpen(false);
  };
  return (
    <div class="relative">
      <button
        type="button"
        class="rounded px-2 py-1 text-xs text-faint hover:(bg-surface-2 text-ink) md:px-1.5 md:py-0.5"
        data-testid="react-button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add reaction"
      >
        ☺
      </button>
      <Show when={open()}>
        <div
          class="absolute top-full right-0 z-10 mt-1 flex gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-lg"
          data-testid="reaction-picker"
        >
          <For each={QUICK_REACTIONS}>
            {(r) => (
              <button
                type="button"
                class="rounded px-2 py-1 text-base hover:bg-surface-2 md:px-1 md:py-0.5 md:text-sm"
                data-testid="reaction-pick"
                data-reaction-key={r.key}
                onClick={() => pick(r.key, r.unicode)}
              >
                {r.unicode}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

/**
 * The reaction-chip bar under a message. Each chip shows the emoji + count and
 * highlights when the current user holds that key; clicking it toggles via
 * `onToggle(key, unicode)`. `resolveName` maps an author actor to a display name
 * for the chip title (per-group for channels, global for DMs).
 */
export const ReactionBar: Component<{
  reactions: () => ReactionGroupView[];
  myKeys: () => Set<string>;
  onToggle: (key: string, unicode: string) => void;
  resolveName: (actor: string) => string;
}> = (props) => (
  <Show when={props.reactions().length > 0}>
    <div class="fa-rx" data-testid="reactions">
      <For each={props.reactions()}>
        {(g) => (
          <button
            type="button"
            class="fa-rx__chip"
            classList={{ "fa-rx__chip--on": props.myKeys().has(g.key) }}
            data-testid="reaction-chip"
            data-reaction-key={g.key}
            title={g.authors.map((a) => props.resolveName(a)).join(", ")}
            onClick={() => props.onToggle(g.key, g.unicode ?? g.key)}
          >
            <span>{g.unicode ?? g.key}</span>
            <span data-testid="reaction-count">{g.authors.length}</span>
          </button>
        )}
      </For>
    </div>
  </Show>
);
