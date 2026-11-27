/**
 * §12 coverage map — Client MUST and SHOULD items (the `packages/web` client and its e2e tests).
 *
 * Each `item` is the verbatim §12 text; `checklist.test.ts` fails if it drifts from the spec.
 * After editing, run `bun run conformance:render` to regenerate CONFORMANCE.md.
 */
import type { ChecklistEntry } from "./types.ts";

export const CLIENT: readonly ChecklistEntry[] = [
  {
    item: "Support Ed25519 request signing over the §4.4.2 canonical string (fresh per-request nonce, body digest) for all authenticated requests",
    level: "client-must",
    covers: [
      "packages/web/test/ofscp-client.test.ts",
      "packages/web/test/ofscp-client-retry.test.ts",
      "packages/shared/test/signing.test.ts",
      "packages/shared/test/conformance.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Complete the WebSocket signed-challenge handshake before sending other commands (§7.1)",
    level: "client-must",
    covers: [
      "packages/web/test/ofscp-ws.test.ts",
      "packages/shared/test/ws-auth.test.ts",
      "packages/shared/test/conformance.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: the chat controller sends `message.*`, `reaction.*` and `typing.*` through `sendRaw`, which only checks the socket is open, so they can go out before `authenticated` (server closes `4001`). Untested: a command issued during the handshake is held or refused.",
  },
  {
    item: "Handle the registration-mode errors (`registration_closed`, `invite_required`) when registering or claiming a guest account (§4.1.1)",
    level: "client-must",
    covers: [],
    status: "missing",
    note: 'Not implemented: the web client never references `registration_closed` / `invite_required` or `inviteToken` and shows only a generic error on register and claim. Spec question: does "handle" require an invite-token path for `invite_required`, beyond surfacing the error?',
  },
  {
    item: "Derive `dmId` per §7.4 (no sender copy is stored server-side)",
    level: "client-must",
    covers: [
      "packages/shared/test/dm.test.ts",
      "packages/shared/test/conformance.test.ts",
      "packages/web/test/dm-store.test.ts",
      "e2e/tests/dms.spec.ts",
      "e2e/tests/federation.spec.ts",
    ],
    status: "covered",
  },
  {
    item: "Key messages by (holding provider, `id`) and reply parents by (`reference.provider`, `reference.id`), never merging or de-duplicating messages or DM events across providers; set `reference.provider` on a DM reply whose parent another provider holds, and still show a reply whose parent it cannot resolve (§7.1, §7.2, §7.4)",
    level: "client-must",
    covers: [],
    status: "missing",
    note: 'Not implemented: `DmMessage` records no holding provider (`packages/web/src/stores/dms.ts:27`), so a thread mixing received messages (home ids) with retained sent ones (counterparty ids) is de-duplicated and replaced by bare `id` (`stores/dms.ts:148`, `:162`) and DM reactions are keyed by bare `reference.id` (`stores/dms.ts:317`); a reply is sent as `{ type: "reply", id }` with no `provider` (`packages/web/src/components/dms/DmsPage.tsx:1257`), and its parent and replies are matched by bare id (`DmsPage.tsx:828`, `:837`). Channel stores key by bare `channelId` (`packages/web/src/stores/chat.ts:75`). Untested, including a reply whose parent is unresolved.',
    context:
      'A reply whose parent is not loaded still renders, quoting "a message" (`packages/web/src/components/shared/ReplyQuote.tsx:28`).',
  },
  {
    item: "For remote channels, open the real-time WebSocket to the channel's home provider (not the user's own) and complete the §7.1 handshake there (§8.5)",
    level: "client-must",
    covers: ["e2e/tests/federation.spec.ts", "packages/web/test/ofscp-ws.test.ts"],
    status: "partial",
    note: "Behaviour gap: only the home feed opens a per-host socket; the chat view always uses the home socket and the groups route is home-only, so a remote channel cannot be opened, read live or posted to outside the feed.",
  },
  {
    item: "Compose the home feed client-side by reading each followed channel live from its source (§7.6); do not rely on a server-compiled feed",
    level: "client-must",
    covers: [
      "packages/web/test/feed-store.test.ts",
      "e2e/tests/feed.spec.ts",
      "e2e/tests/federation.spec.ts",
    ],
    status: "covered",
  },
  {
    item: "Support all message types or graceful fallback",
    level: "client-must",
    covers: ["e2e/tests/chat.spec.ts", "packages/shared/test/schemas.test.ts"],
    status: "partial",
    note: "The feed and DM renderers have no unknown-type test.",
  },
  {
    item: "Treat the `message.created` that answers a duplicate create (no `cursor`) as the result of the pending send, not as a new message, and never store it as a resume point (§7.1)",
    level: "client-must",
    covers: [
      "packages/web/test/chat-store.test.ts",
      "packages/web/test/cursor.test.ts",
      "packages/server/test/message-create.test.ts",
    ],
    status: "partial",
    note: "Untested: a correlated, cursor-less `message.created` driven through the chat controller's handler, and `OfscpWsClient.cursorFor` staying unchanged on a cursor-less event.",
  },
  {
    item: "Set an avatar by uploading it to the home provider (`POST /api/media`) and then sending its `url` in `PATCH /api/me/profile` (§6.3)",
    level: "client-must",
    covers: ["e2e/tests/social.spec.ts", "packages/web/test/profile-form.test.ts"],
    status: "covered",
  },
  {
    item: "Upload every attachment to the home provider, including for posts to remote channels and DMs, naming as `target` the provider that will hold the message, and reusing an upload only in messages on its target, uploading again for any other provider (§5.8)",
    level: "client-must",
    covers: ["e2e/tests/chat.spec.ts", "e2e/tests/dms.spec.ts"],
    status: "partial",
    note: "Behaviour gap: `uploadMedia` never sends a `target` part, so cross-provider DM attachments upload as home-local uploads, and nothing tracks an upload's target for reuse. The existing tests cover same-provider upload only.",
  },
  {
    item: "Render `text/plain` and CommonMark `text/markdown`, showing raw HTML in Markdown as text; render `text/html` only through the §5.3 allow-list sanitizer (or as text with tags removed); make only `http`, `https`, `mailto` and `attachment:` links active (§5.3)",
    level: "client-must",
    covers: ["packages/web/test/markdown.test.ts", "packages/web/test/inline.test.ts"],
    status: "partial",
    note: "Behaviour gaps: rendering ignores `content.mime` (`text/plain` gets inline formatting, non-article `text/markdown` gets only the inline subset, `text/html` is neither sanitised nor tag-stripped), the Markdown renderer is a CommonMark subset, and `attachment:` links are inert; `mailto:` being active is untested. Scheme-less and relative links must be inactive (a message has no base URL); today they pass `safeHref`.",
  },
  {
    item: "Resolve `attachment:<id>` references against the message's own attachments, show unreferenced attachments after the body, and, when an article has no `title`, use its body's first block as the title if that block is a level-1 heading (ATX or Setext, or `<h1>`) (§5.3)",
    level: "client-must",
    covers: [],
    status: "missing",
    note: "Not implemented: no `attachment:<id>` resolution, the article view ignores `title` and renders no attachments, and the title fallback takes any `#`–`###` heading or the first line. The e2e tests that touch article titles do not assert the spec rules; spec question: is an article with no `title` and no H1 first block untitled?",
  },
  {
    item: "Treat attachment metadata and files as untrusted, never opening a fetched file as an active document: a plain link to its `url` is allowed, `blob:`/`data:` URLs, `srcdoc` and frames are not (§5.8)",
    level: "client-must",
    covers: ["packages/web/test/chat-api.test.ts"],
    status: "partial",
    note: "Untested: a `text/html` or `image/svg+xml` attachment never renders inline as a document. A plain link to the `url` is allowed; `blob:`/`data:` URLs, `srcdoc` and frames must not be used for attachments.",
  },
  {
    item: "Render metadata extensions when schemas known",
    level: "client-should",
    covers: [],
    status: "missing",
    note: "No `metadata` rendering exists in the web client. Spec question: with no known extension schema this may hold vacuously.",
  },
  {
    item: "Provide UX for tiers (access + discoverability)",
    level: "client-should",
    covers: ["e2e/tests/groups.spec.ts", "e2e/tests/feed.spec.ts", "e2e/tests/chat.spec.ts"],
    status: "covered",
  },
  {
    item: "Handle federation latency + retries",
    level: "client-should",
    covers: ["packages/web/test/ofscp-client-retry.test.ts"],
    status: "partial",
    note: "The HTTP `503` + `Retry-After` re-sign is tested; the WebSocket backoff reconnect with `since` resume after a drop is not.",
  },
  {
    item: "Name the DM recipient in `to`, record a conversation pointer at the home provider after a cross-provider send, and read sent history from the counterparty's provider (§7.4)",
    level: "client-should",
    covers: ["e2e/tests/dms.spec.ts", "e2e/tests/federation.spec.ts"],
    status: "partial",
    note: "Behaviour gap: sent history is never read from the counterparty's provider, so a second device has none for a cross-provider DM. Untested: `to` on the wire and the home pointer after a cross-provider send.",
  },
  {
    item: "Not load remote content a message body names, or the attachments of an author on another provider than the message's, without a user action (§5.3)",
    level: "client-should",
    covers: [],
    status: "missing",
    note: "Attachments of authors on other providers auto-load (`<img>`/`<video>`/`<audio>`) with no user action. Body-named remote images are never loaded (no image syntax), but that is untested.",
  },
  {
    item: "Set `mentions` on messages that mention users (§5.3)",
    level: "client-should",
    covers: [],
    status: "missing",
    note: "Not implemented: neither the channel nor the DM send sets `mentions`, although `lib/mentions.ts` can parse them.",
  },
  {
    item: "Record a membership pointer at the home provider after joining a remote group, and remove it after leaving (§5.7)",
    level: "client-should",
    covers: [],
    status: "missing",
    note: "Not implemented: the web client never calls the home membership-pointer API and has no remote-group join UI.",
  },
  {
    item: "Refresh an expired or failing attachment `url` by re-reading its message (§5.8)",
    level: "client-should",
    covers: [],
    status: "missing",
    note: "Not implemented: no `expiresAt` handling and no refetch of the message on an attachment load error.",
  },
];
