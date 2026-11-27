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
    ],
    status: "partial",
    note: "Behaviour gap: `GET …/channels/{channelId}` for an unreadable channel answers `403` (tests assert it) where §11.3 wants `404`, and `PATCH`/`DELETE` channel skip the read check. Spec question: should `GET …/channels` of an unreadable group be `403`, `404` or an empty list?",
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
    ],
    status: "partial",
    note: 'Behaviour gap: edit/delete in a channel the caller cannot read is not answered `404` first, so an author who lost access can still edit or delete and a non-author gets a `403` that leaks existence. "No limit when `editUntil` is absent" is vacuous: every message is stamped with a 900 s window.',
  },
  {
    item: "Accept `text/plain` and `text/markdown` bodies for every message type; store the article fields `title`, `summary` and `cover` (rejecting a `cover` that names none of the message's attachments) and ignore them on other types; store `mentions` and use it in place of text parsing when present (§5.3, §10.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/message-create-fields.test.ts",
      "packages/server/test/message-edit-fields.test.ts",
      "packages/shared/test/edits-media-groups.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: mention notifications are still parsed from the text, never from `mentions`; and no server test creates or edits a `text/markdown` `message`, `memo` or `article`. Spec question: §10.1 is optional, so is using `mentions` binding only on providers that implement it?",
  },
];
