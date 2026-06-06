// Install the browser Buffer shim BEFORE any module that touches signing
// (@forumall/shared encodes keys/sigs through Node's Buffer).
import "./lib/buffer-polyfill.ts";
import "uno.css";
// Terminal Garden design tokens (CSS variables + .fa-* component classes).
// MUST load after uno.css so the variable layer the UnoCSS tokens resolve to wins.
import "./forumall.css";
import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { type ChatMessage, upsertMessage } from "./stores/chat.ts";
import { presence } from "./stores/presence.ts";
import { sessionClient, sessionWs } from "./stores/session.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// Test/debug hook: drive a SIGNED request through the live session client and
// return just the HTTP status. Used by the e2e harness to confirm the server
// honors / revokes the device key (a signed call returns 200 while valid, 401
// after the key is revoked). It exposes no key material — only the active
// client's own signing path, which already lives in this browser.
(
  globalThis as unknown as { __forumall_signedFetch?: (path: string) => Promise<number> }
).__forumall_signedFetch = async (path: string): Promise<number> => {
  const client = sessionClient();
  if (!client) return 0;
  try {
    const res = await client.get(path);
    return res.status;
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) {
      return Number((err as { status: number }).status);
    }
    return -1;
  }
};

// Test/debug hook: inject a message straight into the chat store's timeline for a
// channel. The product cannot compose `article`/unknown-`type` messages (the WS
// `message.create` path forces `type: "message"`), so the e2e suite uses this to
// fabricate those variants and assert the §5.3/§2.3 rendering (markdown + the
// unknown-type text fallback). It only touches the in-memory render store — no
// network, no key material — mirroring `__forumall_signedFetch` above.
(
  globalThis as unknown as {
    __forumall_injectMessage?: (channelId: string, message: ChatMessage) => void;
  }
).__forumall_injectMessage = (channelId: string, message: ChatMessage): void => {
  upsertMessage(channelId, message);
};

// Test/debug hook: read the live session's OWN DM inbox for a conversation via a
// SIGNED `GET /api/dms/{dmId}/messages` and return just the message texts. The
// e2e DM suite uses this to prove the §8.3 invariant directly against the server:
// the SENDER's inbox does NOT contain its own sent message (no sender copy), while
// the recipient's does. It exposes no key material — only the active client's own
// signed read path, which already lives in this browser (mirrors the hooks above).
(
  globalThis as unknown as { __forumall_dmInbox?: (dmId: string) => Promise<string[]> }
).__forumall_dmInbox = async (dmId: string): Promise<string[]> => {
  const client = sessionClient();
  if (!client) return [];
  try {
    const res = await client.get<{ items: { content?: { text?: string } }[] }>(
      `/api/dms/${dmId}/messages?direction=forward`,
    );
    return (res.data.items ?? []).map((m) => m.content?.text ?? "");
  } catch (err) {
    // A 404 (no inbox conversation row for this caller) → empty inbox.
    if (
      err &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status: number }).status === 404
    ) {
      return [];
    }
    throw err;
  }
};

// Test/debug hook: drive a SIGNED cross-provider request through a per-host
// client built from the live session's HOME identity (actor + device key), with
// `authority` = the target host. This is the exact §4.4.2 shape a peer verifies
// after resolving the home key via §4.6 — it exposes no key material beyond the
// session's own signing path. The two-provider federation e2e uses it to drive
// the browser-level cross-provider join (`POST /api/groups/{g}/channels/{c}/join`
// on the peer) — the one cross-provider action the UI has no input for — and to
// follow a remote channel by its canonical URI (which then flows through the REAL
// feed controller). Mirrors `__forumall_signedFetch` above.
(
  globalThis as unknown as {
    __forumall_federation?: (
      host: string,
      method: string,
      path: string,
      body?: unknown,
    ) => Promise<{ status: number; body: unknown }>;
  }
).__forumall_federation = async (host, method, path, body) => {
  const { clientForHost } = await import("./lib/federation.ts");
  const { keyStore } = await import("./lib/key-store.ts");
  const { session } = await import("./stores/session.ts");
  const { canonicalAuthority } = await import("@forumall/shared");
  const actor = session.actor;
  const keyId = session.keyId;
  const home = session.host;
  if (!actor || !keyId || !home) return { status: 0, body: undefined };
  const privateKey = await keyStore.getKey(keyId);
  if (!privateKey) return { status: 0, body: undefined };
  // A same-host call still routes through the home transport (authority == home).
  const target = canonicalAuthority(host) === canonicalAuthority(home) ? home : host;
  const client = clientForHost(target, { actor, keyId, privateKey });
  try {
    const res = await client.request(method, path, body);
    return { status: res.status, body: res.data };
  } catch (err) {
    if (err && typeof err === "object" && "status" in err) {
      return {
        status: Number((err as { status: number }).status),
        body: (err as { body?: unknown }).body,
      };
    }
    return { status: -1, body: String(err) };
  }
};

// Test/debug hook: snapshot the live presence store + WS connection state. The
// e2e presence suite uses this to read a subject's observed availability directly
// (independent of which screen renders a dot) and to assert the WS is connected.
(
  globalThis as unknown as {
    __forumall_presence?: () => {
      connection: string | undefined;
      self: { availability: string; status?: string };
      byActor: Record<string, { availability: string; status?: string; lastSeen?: string }>;
    };
  }
).__forumall_presence = () => ({
  connection: sessionWs()?.state,
  self: { ...presence.self },
  byActor: JSON.parse(JSON.stringify(presence.byActor)),
});

render(() => <App />, root);
