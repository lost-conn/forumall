/**
 * §12 coverage map — Groups, channels, membership, and message create / idempotency / edit / content.
 *
 * Each `item` is the verbatim §12 text; `checklist.test.ts` fails if it drifts from the spec.
 * After editing, run `bun run conformance:render` to regenerate CONFORMANCE.md.
 */
import type { ChecklistEntry } from "./types.ts";

export const GROUPS_MESSAGES: readonly ChecklistEntry[] = [
  {
    item: "Support group and channel management (create/read/update/delete) with the permission model (§5.5)",
    level: "provider-must",
    covers: [
      "packages/server/test/groups.test.ts",
      "packages/server/test/channels.test.ts",
      "packages/server/test/channel-permissions.test.ts",
      "packages/server/test/group-creation-policy.test.ts",
      "packages/server/test/conformance.test.ts",
      "packages/server/test/hidden-channels.test.ts",
    ],
    status: "covered",
    context:
      "`GET`/`PATCH`/`DELETE` of a channel the caller cannot read answer `404` before the `manage` check; `GET …/channels` of an unreadable group answers `403`, as `GET /api/groups/{groupId}` does (§5.5).",
  },
  {
    item: "Support group membership: join/leave, member listing, roles, per-group nicknames, `member.updated`, and the `request` approval flow (§5.7)",
    level: "provider-must",
    covers: [
      "packages/server/test/membership.test.ts",
      "packages/server/test/display-name.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "partial",
    note: "Untested: nickname validation (>64 chars → `400`, blank clears) and its `404`, the role-change subset rule against the target's current role, and `member.updated` to the affected member's own connections.",
  },
  {
    item: 'Support message creation of every type (`message`, `memo`, `article`) with `attachments`, `reference`, `tags` and `metadata`, over both `message.create` and `POST …/messages`, gated by `post:<type>` and by `replyOnly` / `replyOnlyTo` (which only a valid reply, `reference.type` `"reply"` naming an existing message in the channel, satisfies), answering `404` for a channel the actor cannot read (§5.2.1, §7.1)',
    level: "provider-must",
    covers: [
      "packages/server/test/message-create.test.ts",
      "packages/server/test/message-create-fields.test.ts",
      "packages/server/test/ws-message-create.test.ts",
      "packages/server/test/channel-permissions.test.ts",
      "packages/server/test/ws-correlation.test.ts",
      "packages/server/test/conformance.test.ts",
      "packages/shared/test/message-create-schema.test.ts",
    ],
    status: "partial",
    note: "The WebSocket half is thin: `message.create` to an unreadable channel → `not_found`, the `post:<type>` / `replyOnly` / `replyOnlyTo` refusals, and a `memo` or valid reply over WS are untested; so is a REST create in a missing group → `404`.",
  },
  {
    item: "Treat a `reference.provider` as a canonical authority (§2.2), and one equal to its own authority as absent; reject (`400`) a channel reply whose `provider` is not the channel's own provider (§7.1, §7.2)",
    level: "provider-must",
    covers: [],
    status: "missing",
    note: "Not implemented: `MessageReferenceSchema` (`packages/shared/src/schemas/messaging.ts:37`) has no `provider` field, so it passes through unchecked; `authorizeReplyTarget` (`packages/server/src/http/message-mutations.ts:254`) looks the parent up by `reference.id` alone, so a channel reply naming another provider is accepted, and the reference is stored and served verbatim, never canonicalized (`packages/server/src/provider/messages.ts:255`). No test sends a `reference.provider`.",
    context:
      "A `provider` equal to the channel's own authority already behaves as absent, but only because the field is ignored.",
  },
  {
    item: "Serve a `Reaction` whose `reference.provider`, if present, is its own authority, since a reaction is stored with its message (§7.1)",
    level: "provider-must",
    covers: ["packages/server/test/reactions.test.ts"],
    status: "partial",
    note: "Untested for DM reactions: no test asserts the `reference` of a served DM `Reaction` (`rowToDmReaction`, `packages/server/src/provider/dm-reactions.ts:82`); `dm-reactions.test.ts` checks keys and authors only.",
    context:
      "Both mappers build `reference` as `{ type: \"message\", id }` with no `provider` (`provider/reactions.ts:71`, `provider/dm-reactions.ts:89`), taking the spec's SHOULD-omit option. The channel `Reaction`'s exact `reference` is asserted over WS and REST (`reactions.test.ts:337`, `:571`).",
  },
  {
    item: "Treat `(author, channelId, clientMessageId)` as idempotent, running only authentication, visibility and the actor's permission checks before the duplicate lookup and returning the existing message on a duplicate (over WebSocket as a `message.created` with no `cursor`); echo `clientMessageId` on the author's `message.created`, live or replayed, and on every create response (§7.1, §7.4)",
    level: "provider-must",
    covers: [
      "packages/server/test/message-create.test.ts",
      "packages/server/test/ws-message-create.test.ts",
      "packages/server/test/dms-send.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "partial",
    note: "Untested: the duplicate answer reflects the message as it now stands (edited or tombstoned), the key is scoped by `channelId`, and a reply-restricted actor's retry without `reference` → `403`.",
  },
  {
    item: "Carry the full canonical `Message` in `message.created`, `message.updated` and `dm.message` (§7.1, §7.4)",
    level: "provider-must",
    covers: [
      "packages/server/test/message-create.test.ts",
      "packages/server/test/message-edit-fields.test.ts",
      "packages/server/test/conformance.test.ts",
      "packages/shared/test/message-create-schema.test.ts",
      "packages/shared/test/schemas.test.ts",
    ],
    status: "covered",
  },
  {
    item: "Support message edit (author-only; within `editUntil` when set, with no limit when absent) replacing any of `content`, `attachments`, `tags`, `mentions` and the article fields, and tombstone delete (§7.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/message-edit-delete.test.ts",
      "packages/server/test/message-edit-fields.test.ts",
      "packages/server/test/message-edit-dm.test.ts",
      "packages/server/test/ws-correlation.test.ts",
      "packages/shared/test/edits-media-groups.test.ts",
      "packages/server/test/hidden-channels.test.ts",
    ],
    status: "partial",
    note: '"No limit when `editUntil` is absent" is vacuous: every message is stamped with a 900 s window.',
  },
  {
    item: "Accept `text/plain` and `text/markdown` bodies for every message type; store the article fields `title`, `summary` and `cover` (rejecting a `cover` that names none of the message's attachments) and ignore them on other types; store `mentions` (§5.3) and, if the provider offers the §10.1 feed, take a message's mentions from it in place of text parsing when present (§10.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/message-create-fields.test.ts",
      "packages/server/test/message-edit-fields.test.ts",
      "packages/shared/test/edits-media-groups.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: mention notifications are still parsed from the text, never from `mentions`; and no server test creates or edits a `text/markdown` `message`, `memo` or `article`. (Forumall offers the §10.1 feed, so the mentions clause binds it.)",
  },
];
