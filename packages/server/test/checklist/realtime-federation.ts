/**
 * §12 coverage map — DMs, contacts, federation, real-time delivery, presence, notifications and tiers.
 *
 * Each `item` is the verbatim §12 text; `checklist.test.ts` fails if it drifts from the spec.
 * After editing, run `bun run conformance:render` to regenerate CONFORMANCE.md.
 */
import type { ChecklistEntry } from "./types.ts";

export const REALTIME_FEDERATION: readonly ChecklistEntry[] = [
  {
    item: "Support direct messages: deterministic `dmId` derivation, inbox-only storage (no sender copy), the `{dmId}`/`to` verification on delivery, conversation pointers and `dm.conversation`, conversation listing/reading, `dm.message` real-time delivery, and `dmId` subscriptions from a remote participant, answering a non-participant on every DM path exactly as an unknown `dmId` (`404` / `not_found`), where a participant is a caller from whom and some other actor the `dmId` derives, the provider hosting at least one of the two (a local user is a participant of their conversations with remote actors too) (§7.4)",
    level: "provider-must",
    covers: [
      "packages/shared/test/dm.test.ts",
      "packages/shared/test/conformance.test.ts",
      "packages/server/test/dms-send.test.ts",
      "packages/server/test/dms-pointers.test.ts",
      "packages/server/test/dms-read.test.ts",
      "packages/server/test/dms-federation.test.ts",
      "packages/server/test/dm-pointer-hygiene.test.ts",
      "packages/server/test/message-create.test.ts",
      "packages/server/test/canonical-authority.test.ts",
      "packages/server/test/remote-handle-impersonation.test.ts",
      "packages/server/test/dm-subscriptions.test.ts",
      "packages/server/test/dm-reactions.test.ts",
      "packages/server/test/message-edit-dm.test.ts",
      "packages/server/test/read-markers-http.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: `GET /api/dms/{dmId}/messages` and `…/replies` (`packages/server/src/http/dms.ts:76`, `:104`) decide participation from stored rows only (`isDmThreadParticipant`, `packages/server/src/provider/dms.ts:333`), not by derivation, so a participant with nothing stored yet (a remote caller, or a local caller whose counterparty is local) gets `404` instead of an empty page. Untested: those two reads for such a participant.",
    context:
      "`dmId` subscribe and typing decide by derivation (`resolveLocalDmOwner`, `packages/server/src/http/dm-request.ts:42`), and a local caller whose counterparty is remote by its consistent conversation row (an inbox message or a pointer), as §7.4 says; reactions and edits name a message, which exists only once stored. `dm.typing` is delivered to a remote participant's `dmId` subscription (a MAY).",
  },
  {
    item: "Support the explicit contacts model (request/accept/remove, local and federated) backing the `contacts` visibility tier (§6.7)",
    level: "provider-must",
    covers: [
      "packages/server/test/contacts.test.ts",
      "packages/server/test/privacy.test.ts",
      "packages/server/test/presence.test.ts",
    ],
    status: "partial",
    note: 'A federated `action: "remove"` is untested; only `request` and `accept` are sent to `/api/federation/contacts`.',
  },
  {
    item: "Publish provider signing key(s) in discovery and sign provider-to-provider requests (§8.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/server.test.ts",
      "packages/server/test/federation.test.ts",
      "packages/server/test/signer-resolution.test.ts",
      "packages/server/test/notifications.test.ts",
      "packages/shared/test/signing.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Accept direct-WS connections from remote members — resolve remote keys via §4.6, enforce prior membership + tier at subscribe-time — and advertise `capabilities.federation.realtimeDelivery` (§8.5)",
    level: "provider-must",
    covers: [
      "packages/server/test/federation-realtime.test.ts",
      "packages/server/test/ws-remote-key.test.ts",
      "packages/server/test/server.test.ts",
      "packages/server/test/federation-actor.test.ts",
      "packages/server/test/federation-realtime-access.test.ts",
    ],
    status: "covered",
    context: "The `dmId` part of remote subscriptions is tracked under the direct-messages item.",
  },
  {
    item: "Support the follow list (`GET`/`POST`/`DELETE /api/me/follows`) as pointers only — no server-side feed compilation or content replication — with each `groupId` derived from the channel as a ref, never taken from the request (§7.6)",
    level: "provider-must",
    covers: ["packages/server/test/follows.test.ts", "packages/server/test/conformance.test.ts"],
    status: "partial",
    note: "Behaviour gap: `POST /api/me/follows` stores the request body's `groupId` (`packages/server/src/http/follows.ts:128`, passed to `addFollow` at `:158`, stored by `packages/server/src/provider/follows.ts:63`) instead of ignoring it and deriving the group from the channel (the local channel's `groupId`; for a remote channel URI, `https://{domain}/api/groups/{groupId}` on its authority). A follow posted without `groupId` gets none. `packages/server/test/follows.test.ts:161` sends `groupId` and asserts the echo (`:168`), so no test checks derivation or that a mismatched body `groupId` is ignored. Pointers-only storage is implemented and tested.",
  },
  {
    item: "Support WebSocket resume (`since` replay with per-message cursors, each replayed event carrying the message's current state, a since-deleted message replaying as a `message.created` with the tombstone followed by its `message.deleted`), accept a channel's event cursors as its REST history and reply-listing `cursor` and those listings' cursors as `since`, and likewise for a DM conversation's `dm.message` cursors, history and reply listing on the provider that issued them, and support the `ping`/`pong` heartbeat (§7.1, §7.2)",
    level: "provider-must",
    covers: [
      "packages/server/test/ws-resume.test.ts",
      "packages/server/test/ws-envelope-rules.test.ts",
      "packages/server/test/dm-subscriptions.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: a since-deleted message replays only as a `message.created` carrying the tombstone, with no `message.deleted` after it (`packages/server/src/http/ws/subscriptions.ts:168`; `ws-resume.test.ts:104` asserts just the tombstone). Untested: a channel event cursor used as the REST history or reply-listing `cursor`, a listing cursor used as `since`, and the same for DM cursors (`dm-subscriptions.test.ts:199` covers DM resume only).",
    context:
      "Channel and DM cursors all encode the one global `seq` (`encodeMessageCursor`), so they should be interchangeable.",
  },
  {
    item: "Support real-time presence over WebSocket: `presence.subscribe`/`set`, `presence.update` fan-out, connection-derived online/offline, and §6.1 visibility filtering consistent with the REST presence endpoint (§7.5)",
    level: "provider-must",
    covers: [
      "packages/server/test/presence.test.ts",
      "packages/server/test/remote-presence-federation.test.ts",
      "packages/server/test/presence-live.test.ts",
      "packages/server/test/federation-realtime-access.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support message fan-out + notification endpoints",
    level: "provider-must",
    covers: [
      "packages/server/test/notifications.test.ts",
      "packages/server/test/ws-hub-fanout.test.ts",
      "packages/server/test/ws-message-create.test.ts",
      "packages/server/test/notification-endpoints.test.ts",
    ],
    status: "covered",
  },
  {
    item: 'Enforce tiers per channel and group, using the single effective-read-access rule (§11.3) on every surface, and end live subscriptions with `unsubscribed` (`reason: "access_revoked"`) when access is lost (§7.1)',
    level: "provider-must",
    covers: [
      "packages/server/test/channels.test.ts",
      "packages/server/test/groups.test.ts",
      "packages/server/test/messages.test.ts",
      "packages/server/test/channel-permissions.test.ts",
      "packages/server/test/membership.test.ts",
      "packages/server/test/ws-subscriptions.test.ts",
      "packages/server/test/ws-access-revocation.test.ts",
      "packages/server/test/follows.test.ts",
      "packages/server/test/read-markers-http.test.ts",
      "packages/server/test/notifications-feed.test.ts",
      "packages/server/test/discovery-feed.test.ts",
      "packages/server/test/hidden-channels.test.ts",
      "packages/server/test/reader-participation.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Answer a channel the caller may not read (any §11.3 condition fails, including an unreadable group) exactly as a missing channel on every surface except the channel-join alias (`404` / `not_found`, unknown read-marker scope); `403` only when the caller can read the channel but lacks a permission (§11.3)",
    level: "provider-must",
    covers: [
      "packages/server/test/ws-subscriptions.test.ts",
      "packages/server/test/federation-realtime.test.ts",
      "packages/server/test/read-markers-http.test.ts",
      "packages/server/test/notifications-feed.test.ts",
      "packages/server/test/discovery-feed.test.ts",
      "packages/server/test/message-create.test.ts",
      "packages/server/test/hidden-channels.test.ts",
      "packages/server/test/reader-participation.test.ts",
      "packages/server/test/channels.test.ts",
      "packages/server/test/messages.test.ts",
      "packages/server/test/channel-permissions.test.ts",
      "packages/server/test/reactions.test.ts",
      "packages/server/test/typing.test.ts",
      "packages/server/test/follows.test.ts",
    ],
    status: "covered",
    context:
      "`hidden-channels.test.ts` hides one channel three ways (group unreadable, channel tier, `view`) and compares every REST and WS answer with the missing-channel answer. The channel list names only the group, so it answers as `GET /api/groups/{groupId}` does (`403` for an unreadable group, §5.5).",
  },
  {
    item: "Handle an unsigned request to a route that accepts anonymous readers as an anonymous viewer (`public` access only, never `401`), keeping `401` for signed requests that fail §4.5 and for a permitted provider's signature (§4.5, §8)",
    level: "provider-must",
    covers: [
      "packages/server/test/groups.test.ts",
      "packages/server/test/channels.test.ts",
      "packages/server/test/messages.test.ts",
      "packages/server/test/replay-warmup.test.ts",
      "packages/server/test/signature.test.ts",
      "packages/server/test/users-anonymous.test.ts",
      "packages/server/test/public-route-signatures.test.ts",
      "packages/server/test/provider-signed-routes.test.ts",
    ],
    status: "covered",
    context:
      "`provider-signed-routes.test.ts` sends a permitted provider's signature, and this provider's own valid one, to every anonymous-reader route: `401`, never served as an anonymous viewer, with no discovery fetch or nonce recorded; a digest mismatch gets the step-5 `400`.",
  },
  {
    item: "Support the `private` tier",
    level: "provider-must",
    covers: [
      "packages/server/test/groups.test.ts",
      "packages/server/test/channels.test.ts",
      "packages/server/test/membership.test.ts",
      "packages/server/test/server.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Expose `GET /api/tiers` endpoint",
    level: "provider-must",
    covers: ["packages/server/test/server.test.ts", "packages/server/test/conformance.test.ts"],
    status: "covered",
  },
  {
    item: "On create, store `metadata` as given, rejecting (`400`) an invalid metadata object (§5.4, §7.1)",
    level: "provider-must",
    covers: ["packages/server/test/message-create.test.ts", "packages/shared/test/schemas.test.ts"],
    status: "covered",
  },
];
