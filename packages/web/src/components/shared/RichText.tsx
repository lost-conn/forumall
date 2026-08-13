/**
 * Shared inline message renderer — turns a chat/DM body into formatted Solid
 * elements (bold, italic, inline code, links) with `@mentions` rendered as the
 * same styled, clickable token used across the app. Used by BOTH channel chat
 * (`MessageBody`) and direct messages (`DmMessageBody`).
 *
 * Parsing lives in `lib/inline.ts` (pure, unit-tested); this module is only the
 * presentation. Text is interpolated, not injected — Solid auto-escapes it, so
 * there is no `innerHTML` and nothing a sender types can become live markup.
 */
import { type Component, For, Match, Switch } from "solid-js";
import { type InlineNode, parseInline } from "../../lib/inline.ts";
import { session } from "../../stores/session.ts";
import { openUserProfile } from "../social/user-profile-store.ts";

/** Narrow a node to a specific variant (for the `Switch` arms below). */
function as<T extends InlineNode["type"]>(
  node: InlineNode,
  type: T,
): Extract<InlineNode, { type: T }> | undefined {
  return node.type === type ? (node as Extract<InlineNode, { type: T }>) : undefined;
}

/** Render one inline node, recursing into mark children. */
const RichNode: Component<{ node: InlineNode }> = (props) => (
  <Switch>
    <Match when={as(props.node, "text")}>{(n) => <>{n().value}</>}</Match>
    <Match when={as(props.node, "strong")}>
      {(n) => (
        <strong>
          <RichNodes nodes={n().children} />
        </strong>
      )}
    </Match>
    <Match when={as(props.node, "em")}>
      {(n) => (
        <em>
          <RichNodes nodes={n().children} />
        </em>
      )}
    </Match>
    <Match when={as(props.node, "code")}>
      {(n) => (
        <code class="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">{n().value}</code>
      )}
    </Match>
    <Match when={as(props.node, "link")}>
      {(n) => (
        <a
          href={n().href}
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent hover:underline"
        >
          <RichNodes nodes={n().children} />
        </a>
      )}
    </Match>
    <Match when={as(props.node, "mention")}>
      {(n) => (
        <button
          type="button"
          class="rounded px-0.5 font-medium text-accent hover:underline"
          classList={{ "bg-accent-soft": n().actor === session.actor }}
          data-testid="message-mention"
          data-actor={n().actor}
          onClick={() => openUserProfile(n().actor)}
        >
          {n().raw}
        </button>
      )}
    </Match>
  </Switch>
);

/** Render a list of inline nodes. */
const RichNodes: Component<{ nodes: InlineNode[] }> = (props) => (
  <For each={props.nodes}>{(node) => <RichNode node={node} />}</For>
);

/**
 * Render freeform message text with inline formatting + clickable `@mentions`.
 * The local domain (for resolving bare `@handle`) comes from the session actor.
 */
export const RichText: Component<{ text: string }> = (props) => {
  const localDomain = () => session.actor?.split("@")[1] ?? "";
  return <RichNodes nodes={parseInline(props.text, localDomain())} />;
};
