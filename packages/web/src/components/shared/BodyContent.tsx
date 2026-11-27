/**
 * Renders a parsed message body ({@link BodyNode} tree, `lib/content/`) as
 * Solid elements, and {@link MessageContent} puts a whole message's content
 * together: the body in its format's container, then the attachments the body
 * does not reference (§5.3).
 *
 * Nothing here uses `innerHTML`: text is interpolated (Solid escapes it) and
 * an element node can only name an allow-listed tag, so a sender cannot put
 * live markup on the page. Links are already allow-listed by the parsers;
 * `attachment:` references resolve only against the message's own
 * attachments, and a reference to an id the message lacks shows as its text
 * and fetches nothing.
 */
import type { Attachment } from "@forumall/shared";
import { type Component, For, Match, Show, Switch, createMemo } from "solid-js";
import { Dynamic } from "solid-js/web";
import { attachmentUrl } from "../../lib/attachment-url.ts";
import { type Body, attachmentLayout, parseBody } from "../../lib/content/body.ts";
import type { BodyNode, ElementNode } from "../../lib/content/nodes.ts";
import { session } from "../../stores/session.ts";
import { openUserProfile } from "../social/user-profile-store.ts";
import { AttachmentList } from "./AttachmentList.tsx";
import { AttachmentView } from "./AttachmentView.tsx";

/** Narrow a node to one variant (for the `Match` arms below). */
function as<K extends BodyNode["kind"]>(
  node: BodyNode,
  kind: K,
): Extract<BodyNode, { kind: K }> | undefined {
  return node.kind === kind ? (node as Extract<BodyNode, { kind: K }>) : undefined;
}

/** `rel` for every link a body makes: no opener, no referrer, untrusted content. */
const LINK_REL = "noopener noreferrer nofollow ugc";

/**
 * The attributes an element node carries, only those it has: an `undefined`
 * `start` assigned to an `<ol>` would number it from 0.
 */
function elementAttrs(node: ElementNode): Record<string, number> {
  const attrs: Record<string, number> = {};
  if (node.colspan !== undefined) attrs.colspan = node.colspan;
  if (node.rowspan !== undefined) attrs.rowspan = node.rowspan;
  if (node.start !== undefined) attrs.start = node.start;
  return attrs;
}

const Node: Component<{ node: BodyNode; attachments: readonly Attachment[] }> = (props) => {
  const attachment = (id: string) => props.attachments.find((a) => a.id === id);
  return (
    <Switch>
      <Match when={as(props.node, "text")}>{(n) => <>{n().value}</>}</Match>
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
      <Match when={as(props.node, "element")}>
        {(n) => (
          <Dynamic component={n().tag} {...elementAttrs(n())}>
            <Nodes nodes={n().children} attachments={props.attachments} />
          </Dynamic>
        )}
      </Match>
      <Match when={as(props.node, "link")}>
        {(n) => (
          <a href={n().href} target="_blank" rel={LINK_REL} data-testid="body-link">
            <Nodes nodes={n().children} attachments={props.attachments} />
          </a>
        )}
      </Match>
      <Match when={as(props.node, "attachment-link")}>
        {(n) => {
          const href = () => {
            const att = attachment(n().id);
            return att === undefined ? null : attachmentUrl(att);
          };
          return (
            <Show
              when={href()}
              fallback={<Nodes nodes={n().children} attachments={props.attachments} />}
            >
              {(url) => (
                <a href={url()} target="_blank" rel={LINK_REL} data-testid="body-attachment-link">
                  <Nodes nodes={n().children} attachments={props.attachments} />
                </a>
              )}
            </Show>
          );
        }}
      </Match>
      <Match when={as(props.node, "attachment-embed")}>
        {(n) => (
          <Show when={attachment(n().id)} fallback={n().caption}>
            {(att) => (
              <span class="my-1 inline-block align-top" data-testid="body-attachment">
                <AttachmentView attachment={att()} />
              </span>
            )}
          </Show>
        )}
      </Match>
      <Match when={as(props.node, "remote-image")}>
        {(n) => (
          <a
            href={n().href}
            target="_blank"
            rel={LINK_REL}
            title={n().href}
            data-testid="body-remote-image"
          >
            🖼 {n().alt.length > 0 ? n().alt : n().href}
          </a>
        )}
      </Match>
    </Switch>
  );
};

const Nodes: Component<{ nodes: readonly BodyNode[]; attachments: readonly Attachment[] }> = (
  props,
) => <For each={props.nodes}>{(node) => <Node node={node} attachments={props.attachments} />}</For>;

/**
 * A body's nodes in the container for its format: `text/plain` keeps its line
 * breaks and spacing (`pre-wrap`); Markdown and HTML lay out their own blocks.
 */
export const BodyContent: Component<{
  body: Body;
  nodes?: readonly BodyNode[];
  attachments: readonly Attachment[];
  class?: string;
  testid?: string;
}> = (props) => (
  <div
    class={`break-words ${props.class ?? ""}`}
    classList={{
      "whitespace-pre-wrap": props.body.format === "plain",
      "fa-body": props.body.format !== "plain",
    }}
    data-testid={props.testid}
    data-format={props.body.format}
  >
    <Nodes nodes={props.nodes ?? props.body.nodes} attachments={props.attachments} />
  </div>
);

/** The fields of a message its content rendering reads. */
export interface ContentMessage {
  type?: string;
  content: { mime?: string; text?: string };
  attachments?: Attachment[];
  cover?: string;
}

/** Parse a message's body for the signed-in viewer (bare `@handle` → local). */
export function useParsedBody(message: () => ContentMessage): () => Body {
  return createMemo(() => parseBody(message().content, session.actor?.split("@")[1] ?? ""));
}

/**
 * The attachments a message's body does not reference (other than an
 * article's cover), in `attachments` order: what §5.3 shows after the body.
 */
export const TrailingAttachments: Component<{
  message: ContentMessage;
  body: Body;
  testid?: string;
}> = (props) => {
  const trailing = createMemo(
    () => attachmentLayout(props.message, props.body.referencedAttachmentIds).trailing,
  );
  return (
    <Show when={trailing().length > 0}>
      <div class="mt-1.5">
        <AttachmentList attachments={trailing()} testid={props.testid} />
      </div>
    </Show>
  );
};

/**
 * A message's body followed by the attachments it does not reference (§5.3).
 * Used for channel messages and memos, replies, and the home feed.
 */
export const MessageContent: Component<{
  message: ContentMessage;
  class?: string;
  testid?: string;
  attachmentsTestid?: string;
}> = (props) => {
  const body = useParsedBody(() => props.message);
  return (
    <>
      <BodyContent
        body={body()}
        attachments={props.message.attachments ?? []}
        class={props.class}
        testid={props.testid}
      />
      <TrailingAttachments message={props.message} body={body()} testid={props.attachmentsTestid} />
    </>
  );
};
