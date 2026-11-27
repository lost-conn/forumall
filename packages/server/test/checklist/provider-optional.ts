/**
 * §12 coverage map — Provider SHOULD and MAY items.
 *
 * Each `item` is the verbatim §12 text; `checklist.test.ts` fails if it drifts from the spec.
 * After editing, run `bun run conformance:render` to regenerate CONFORMANCE.md.
 */
import type { ChecklistEntry } from "./types.ts";

export const PROVIDER_OPTIONAL: readonly ChecklistEntry[] = [
  {
    item: "Include the caller's `membership` in `GET /api/groups/{groupId}` for a signed member, never marking that answer publicly cacheable (§5.5)",
    level: "provider-should",
    covers: [],
    status: "missing",
    note: "`GET /api/groups/{groupId}` never includes `membership` and sets no `Cache-Control`; once it does, it must omit it for unsigned/non-members and send `private` or `no-store`.",
  },
  {
    item: "Not mark attachments publicly cacheable unless all their messages are public, and stop serving a local upload once no current message version or profile it holds references it: remove it within a bounded time, or serve it through short-lived URLs with `expiresAt` (§5.8)",
    level: "provider-should",
    covers: ["packages/server/test/media-serving.test.ts"],
    status: "partial",
    note: "Caching is done (`Cache-Control: private, max-age=31536000, immutable`, never public). Nothing tracks references or removes a local upload once unreferenced, and no short-lived URLs are minted.",
  },
  {
    item: "Serve attachments from an origin other than the web client's (§5.8)",
    level: "provider-should",
    covers: [],
    status: "missing",
    note: "Attachment URLs are on the web client's own origin (`https://{domain}/api/media/{id}`); there is no setting for a separate media origin.",
  },
  {
    item: "Give `article` messages a longer edit window than chat, or none (§7.1)",
    level: "provider-should",
    covers: [],
    status: "missing",
    note: "Every message type gets the same `MESSAGE_EDIT_WINDOW_SECONDS` window (default 900 s); there is no per-type window for articles.",
  },
  {
    item: "Maintain and share a known-providers list at `GET /api/providers`, and advertise `capabilities.discovery.sharesKnownProviders` (§8.6)",
    level: "provider-may",
    covers: ["packages/server/test/discovery-feed.test.ts"],
    status: "covered",
  },
  {
    item: "Compile a discovery feed at `GET /api/discover` from discoverable channels (local + known providers) as pointers, and advertise `capabilities.discovery.discoverFeed` (§11.2)",
    level: "provider-may",
    covers: [
      "packages/server/test/discovery-feed.test.ts",
      "packages/server/test/admin-discover.test.ts",
    ],
    status: "partial",
    note: "Only local channels are compiled; aggregation from known providers is not implemented.",
  },
  {
    item: "Offer guest upgrade via `/api/me/claim` (subject to the registration mode, §4.1.1) and `/api/me/merge` (§4.8.1)",
    level: "provider-may",
    covers: [
      "packages/server/test/guest-claim.test.ts",
      "packages/server/test/guest-merge.test.ts",
      "packages/server/test/ws-access-revocation.test.ts",
    ],
    status: "covered",
    context:
      'Only the `open` registration mode exists, so "subject to the registration mode" holds trivially.',
  },
  {
    item: "Offer a notification feed with mentions, per-scope notification settings, and Web Push (§10.1–§10.3)",
    level: "provider-may",
    covers: [
      "packages/server/test/notifications-feed.test.ts",
      "packages/server/test/notification-prefs.test.ts",
      "packages/server/test/push.test.ts",
      "packages/server/test/web-push.test.ts",
      "packages/server/test/push-egress-check.test.ts",
      "packages/shared/test/push.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Embed DM reactions inline in DM history (§7.4)",
    level: "provider-may",
    covers: ["packages/server/test/dm-reactions.test.ts"],
    status: "covered",
  },
  {
    item: "Support DM replies: check the parent only when `reference.provider` is absent or its own (`400` if it is not in the conversation), otherwise require (`400`) a participant's home provider; and serve the reply listing with its `provider` parameter, listing the replies it holds to (`provider`, `{messageId}`) (§7.4)",
    level: "provider-may",
    covers: ["packages/server/test/dm-reactions.test.ts"],
    status: "partial",
    note: "Behaviour gap: a DM send (`packages/server/src/http/dms-federation.ts:55`) stores `body.reference` unchecked (`:119`): no parent lookup in the conversation, no participant-home-provider check of `reference.provider`, no §2.2 canonicalization. The reply listing (`packages/server/src/http/dms.ts:96`) takes no `provider` query parameter, and `listDmReplies` matches on `reference.id` alone (`packages/server/src/provider/dm-reactions.ts:318`), so it also lists replies whose parent another provider holds under the same id. Only same-provider listing is tested (`dm-reactions.test.ts:414`).",
  },
  {
    item: "Keep read markers and unread counts by message id (§7.7)",
    level: "provider-may",
    covers: [
      "packages/server/test/read-markers.test.ts",
      "packages/server/test/guest-claim.test.ts",
    ],
    status: "covered",
  },
];
