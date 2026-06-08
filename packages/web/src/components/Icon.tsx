/**
 * Terminal Garden line icons — ported from the design handoff (`proto/icons.jsx`).
 * Square caps, miter joins, ~1.9 stroke, 24×24 viewBox, `currentColor` stroke so
 * an icon inherits its parent's text color. Use `<Icon name="hash" />`.
 */
import type { Component, JSX } from "solid-js";

export type IconName =
  | "hash"
  | "chat"
  | "article"
  | "memo"
  | "speaker"
  | "mic"
  | "micOff"
  | "video"
  | "search"
  | "plus"
  | "gear"
  | "bell"
  | "users"
  | "reply"
  | "globe"
  | "lock"
  | "home"
  | "chevDown"
  | "chevLeft"
  | "chevRight"
  | "pin"
  | "at"
  | "sort"
  | "boost"
  | "star"
  | "heart"
  | "x"
  | "check"
  | "image"
  | "link"
  | "code"
  | "smile"
  | "send"
  | "more"
  | "fork"
  | "shield"
  | "inbox"
  | "hashLock"
  | "sun";

/**
 * The path geometry for each icon (drawn with `stroke="currentColor"`).
 *
 * Each entry is a **factory** that returns fresh JSX on every call. This is
 * load-bearing: JSX expressions compile to real DOM nodes created once at
 * module-evaluation time. Storing the elements directly would share a single
 * `<path>` DOM node across every `<Icon>` instance — a node can only live in
 * one place, so the icon would vanish from all but the last render and "move"
 * (disappear) when a list reconciles. Calling the factory per-instance gives
 * Solid a brand-new node each time.
 */
const PATHS: Record<IconName, () => JSX.Element> = {
  hash: () => <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" />,
  chat: () => (
    <>
      <path d="M4 5h16v11H10l-5 4V5Z" />
      <path d="M8 9h8M8 12h5" />
    </>
  ),
  article: () => (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  memo: () => (
    <>
      <path d="M3 8v5l5 1 9 4V3L8 7H3Z" />
      <path d="M17 8a4 4 0 0 1 0 6" />
      <path d="M8 14v3a2 2 0 0 0 4 .4" />
    </>
  ),
  speaker: () => (
    <>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="M16 8a5 5 0 0 1 0 8" />
    </>
  ),
  mic: () => (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  micOff: () => <path d="M9 9V6a3 3 0 0 1 6 0v3M5 11a7 7 0 0 0 11.7 5.2M12 18v3M4 4l16 16" />,
  video: () => (
    <>
      <rect x="3" y="6" width="13" height="12" rx="1.5" />
      <path d="m16 10 5-3v10l-5-3" />
    </>
  ),
  search: () => (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  plus: () => <path d="M12 5v14M5 12h14" />,
  gear: () => (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4 4l2.1 2.1M17.9 17.9 20 20M2 12h3M19 12h3M4 20l2.1-2.1M17.9 6.1 20 4" />
    </>
  ),
  bell: () => (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  users: () => (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3 3-5 6-5s6 2 6 5" />
      <path d="M16 6a3 3 0 0 1 0 6M22 20c0-2.5-1.5-4-4-4.5" />
    </>
  ),
  reply: () => (
    <>
      <path d="M9 17 4 12l5-5" />
      <path d="M4 12h11a5 5 0 0 1 5 5v2" />
    </>
  ),
  globe: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>
  ),
  lock: () => (
    <>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  home: () => (
    <>
      <path d="M4 11 12 4l8 7" />
      <path d="M6 10v9h12v-9" />
    </>
  ),
  chevDown: () => <path d="m6 9 6 6 6-6" />,
  chevRight: () => <path d="m9 6 6 6-6 6" />,
  chevLeft: () => <path d="m15 18-6-6 6-6" />,
  pin: () => <path d="M12 3v6M8 9h8l-2 5H10L8 9ZM12 14v7" />,
  at: () => (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 12v2a3 3 0 0 0 5-2 9 9 0 1 0-4 7" />
    </>
  ),
  sort: () => <path d="M7 4v15M7 19l-3-3M7 19l3-3M13 6h8M13 11h6M13 16h4" />,
  boost: () => (
    <>
      <path d="M4 8h11a4 4 0 0 1 0 8H9" />
      <path d="m7 13-3 3 3 3M17 16l3-3-3-3" />
    </>
  ),
  star: () => <path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.8 6.6 19.5l1.2-6L3.3 9.3l6.1-.7Z" />,
  heart: () => <path d="M12 20S4 15 4 9a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 6-8 11-8 11Z" />,
  x: () => <path d="M6 6l12 12M18 6 6 18" />,
  check: () => <path d="m4 12 5 5 11-12" />,
  image: () => (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <circle cx="9" cy="9" r="1.6" />
      <path d="m5 18 5-5 4 3 3-3 4 4" />
    </>
  ),
  link: () => (
    <>
      <path d="M9 15 15 9" />
      <path d="M11 7l1-1a4 4 0 0 1 6 6l-1 1M13 17l-1 1a4 4 0 0 1-6-6l1-1" />
    </>
  ),
  code: () => <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />,
  smile: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 14a4 4 0 0 0 8 0M9 9h.01M15 9h.01" />
    </>
  ),
  send: () => <path d="M4 12 21 4l-6 17-4-7-7-2Z" />,
  more: () => (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  fork: () => (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M6 12h6a3 3 0 0 0 3-3" />
    </>
  ),
  shield: () => <path d="M12 3 5 6v5c0 5 4 8 7 10 3-2 7-5 7-10V6l-7-3Z" />,
  inbox: () => (
    <>
      <path d="M4 13h4l1.5 3h5L16 13h4" />
      <path d="M4 13 6 5h12l2 8v5H4Z" />
    </>
  ),
  hashLock: () => (
    <>
      <path d="M5 9h14M5 15h9M10 4 8 20M16 4l-1 8" />
      <rect x="15" y="14" width="6" height="5" rx="1" />
      <path d="M16.5 14v-1.5a1.5 1.5 0 0 1 3 0V14" />
    </>
  ),
  sun: () => (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4 4l1.5 1.5M18.5 18.5 20 20M20 4l-1.5 1.5M5.5 18.5 4 20" />
    </>
  ),
};

export const Icon: Component<{
  name: IconName;
  size?: number;
  stroke?: number;
  class?: string;
}> = (props) => (
  <svg
    width={props.size ?? 18}
    height={props.size ?? 18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={props.stroke ?? 1.9}
    stroke-linecap="square"
    stroke-linejoin="miter"
    class={props.class}
    style={{ display: "block", flex: "none" }}
    aria-hidden="true"
  >
    {PATHS[props.name]()}
  </svg>
);
