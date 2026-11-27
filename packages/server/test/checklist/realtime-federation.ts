/**
 * §12 coverage map — DMs, contacts, federation, real-time delivery, presence, notifications and tiers.
 *
 * Each `item` is the verbatim §12 text; `checklist.test.ts` fails if it drifts from the spec.
 * After editing, run `bun run conformance:render` to regenerate CONFORMANCE.md.
 */
import type { ChecklistEntry } from "./types.ts";

export const REALTIME_FEDERATION: readonly ChecklistEntry[] = [
  {
    item: "Support direct messages: deterministic `dmId` derivation, inbox-only storage (no sender copy), the `{dmId}`/`to` verification on delivery, conversation pointers and `dm.conversation`, conversation listing/reading, `dm.message` real-time delivery, and `dmId` subscriptions from a remote participant, answering a non-participant on every DM path exactly as an unknown `dmId` (`404` / `not_found`) (§7.4)",
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
      "packages/server/test/read-markers.test.ts",
    ],
    status: "covered",
    context:
      "A participant is an actor the `dmId` derives from together with a local user; a local actor whose counterparty is on another provider is recognised by its consistent conversation row instead, since the one-way `dmId` names no local user then. `dm.typing` is delivered to a remote participant's `dmId` subscription (a MAY).",
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
    ],
    status: "partial",
    note: "The `dmId` part of remote subscriptions is tracked under the direct-messages item. No remote-specific test of a member blocked by tier/`view` or of remote `since` resume (both reuse the local path).",
  },
  {
    item: "Support the follow list (`GET`/`POST`/`DELETE /api/me/follows`) as pointers only — no server-side feed compilation or content replication (§7.6)",
    level: "provider-must",
    covers: ["packages/server/test/follows.test.ts", "packages/server/test/conformance.test.ts"],
    status: "covered",
  },
  {
    item: "Support WebSocket resume (`since` replay with per-message cursors) and the `ping`/`pong` heartbeat (§7.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/ws-resume.test.ts",
      "packages/server/test/ws-envelope-rules.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support real-time presence over WebSocket: `presence.subscribe`/`set`, `presence.update` fan-out, connection-derived online/offline, and §6.1 visibility filtering consistent with the REST presence endpoint (§7.5)",
    level: "provider-must",
    covers: [
      "packages/server/test/presence.test.ts",
      "packages/server/test/remote-presence-federation.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "partial",
    note: "Untested: privacy filtering of a live `presence.update` (only snapshots are asserted), `allowList`/`denyList` over WS, heartbeat timeout → offline + `lastSeen`, `PUT /api/me/presence` fan-out, and `presence.unsubscribe`.",
  },
  {
    item: "Support message fan-out + notification endpoints",
    level: "provider-must",
    covers: [
      "packages/server/test/notifications.test.ts",
      "packages/server/test/ws-hub-fanout.test.ts",
      "packages/server/test/ws-message-create.test.ts",
    ],
    status: "partial",
    note: "Untested: `GET /api/notifications/endpoints` (shape, caller's own only) and `DELETE /api/notifications/endpoints/{id}` (`204`; `404` for another caller's or unknown).",
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
      "packages/server/test/read-markers.test.ts",
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
      "packages/server/test/read-markers.test.ts",
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
    item: "Handle an unsigned request to a route that accepts anonymous readers as an anonymous viewer (`public` access only, never `401`), keeping `401` for signed requests that fail §4.5 (§4.5)",
    level: "provider-must",
    covers: [
      "packages/server/test/groups.test.ts",
      "packages/server/test/channels.test.ts",
      "packages/server/test/messages.test.ts",
      "packages/server/test/replay-warmup.test.ts",
      "packages/server/test/signature.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: `GET /api/users/{userRef}/profile`, `…/presence` and `…/groups` require a signature, so an unsigned request gets `401`. Untested: anonymous `…/replies`, and a partial or invalid signature on an anonymous route → `401`.",
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
