// Install the browser Buffer shim BEFORE any module that touches signing
// (@forumall/shared encodes keys/sigs through Node's Buffer).
import "./lib/buffer-polyfill.ts";
import "uno.css";
import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { type ChatMessage, upsertMessage } from "./stores/chat.ts";
import { sessionClient } from "./stores/session.ts";

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

render(() => <App />, root);
