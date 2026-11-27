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
      "packages/server/test/membership-requests.test.ts",
      "packages/server/test/display-name.test.ts",
      "packages/server/test/conformance.test.ts",
    ],
    status: "partial",
    note: "Untested: nickname validation (>64 chars → `400`, blank clears) and its `404`, the role-change subset rule against the target's current role, and `member.updated` to the affected member's own connections.",
  },
  {
    item: "List the owner among the members with role `owner`, keep `joinedAt` across role changes and ownership transfers, and keep the member list's order stable for cursor paging (§5.7)",
    level: "provider-must",
    covers: ["packages/server/test/membership.test.ts", "packages/server/test/groups.test.ts"],
    status: "partial",
    note: "Untested: `GET …/members` lists the owner with role `owner` (`membership.test.ts:290` checks users only; `groups.test.ts:145` reads the stored row), the creator's `joinedAt` equals the group's `createdAt`, and `joinedAt` is unchanged after a role change or an ownership transfer (`membership.test.ts:372`, `:412` check roles only).",
    context:
      "The behaviour is there: the creator's row is stamped with the group's `createdAt` (`packages/server/src/provider/groups.ts:122`, `:130`), role changes and transfers update only `role` (`provider/membership.ts:242`, `:277`), and the listing pages by the total order (`joinedAt`, `user`) (`provider/membership.ts:173`), which `membership.test.ts:290` walks without skip or repeat.",
  },
  {
    item: "Answer a repeat `join` under the `request` policy with `202` and the caller's existing pending `JoinRequest`, unchanged; answer `leave` from a non-member with `404` (and from the owner with `409`) (§5.7)",
    level: "provider-must",
    covers: ["packages/server/test/membership.test.ts"],
    status: "partial",
    note: "Untested: a repeat `join` carrying a different `message` leaves the pending request unchanged (`membership.test.ts:178` repeats with no body and compares `id` only), and `leave` from a non-member → `404` (`packages/server/src/http/membership.ts:162`).",
    context:
      "`requestToJoin` returns the existing pending row as stored (`packages/server/src/provider/membership.ts:355`); the owner's `409` is tested (`membership.test.ts:257`).",
  },
  {
    item: "Gate join-request approve and deny on `manage` or `moderate`, without the subset rule; give an approved requester role `member` (`guest` for a guest account, and `403` with the request unchanged for a guest past its `expiresAt`), and answer an approval for someone already a member with `200` and the existing `Member`, marking the request `approved` (§5.7)",
    level: "provider-must",
    covers: ["packages/server/test/membership.test.ts"],
    status: "partial",
    note: "Behaviour gap: approval always adds the requester as `member` (`packages/server/src/provider/membership.ts:418`), so a guest account is given `member`, not `guest`, and nothing checks a guest's `expiresAt`, so an expired guest's request is approved rather than refused with `403` and left unchanged; forumall#52 is the open fix for §5.6/§5.7 invites and join requests. Untested: approve and deny by a role holding only `moderate`, and their `403` for a caller holding neither (only the listing's `403` is, `membership.test.ts:678`); an approval for a requester who is already a member → `200` with the existing `Member` unchanged and the request `approved` (`packages/server/src/provider/membership.ts:395`).",
    context:
      "Approve and deny check `manage` or `moderate` and apply no subset rule (`packages/server/src/http/membership.ts:432`, `:456`); the owner's approval → `member` is tested (`membership.test.ts:611`).",
  },
  {
    item: "Keep pending join requests across tier and `joinPolicy` changes; reject an approval with `409` `conflict` while the effective join policy is `invite` (including a group whose tier makes it invite-only, such as `private`), leaving the request `pending`, and check this first, before the already-a-member case, so a requester who is already a member still gets `409`; still allow deny (§5.7)",
    level: "provider-must",
    covers: [],
    status: "missing",
    note: "Not implemented: approve (`packages/server/src/http/membership.ts:424`) never checks `effectiveJoinPolicy`, so a request is approved after the group becomes invite-only or `private`. No test of any part: approve after a tier or `joinPolicy` change, the `409`, deny after such a change.",
    context:
      "Pending requests already survive tier and `joinPolicy` changes: only deleting the group removes them (`packages/server/src/provider/groups.ts:173`).",
  },
  {
    item: "On invite creation, reject a `role` that is `owner` or neither canonical nor in the group's `roles`, and a `channelId` that is not a channel of the group, with `400`, and an invite whose role holds a permission the creator lacks with `403`; return the invite's `token` in the `201` (it may be omitted elsewhere, including the invite listing), mint tokens with at least 128 bits of entropy from a cryptographically secure random source, and store them so that a database leak does not reveal them, e.g. as a SHA-256 digest looked up by digesting the presented token; send `Referrer-Policy: no-referrer` from any join-link page and do not log tokens (§5.6)",
    level: "provider-must",
    covers: ["packages/server/test/conformance.test.ts", "packages/server/test/invites.test.ts"],
    status: "partial",
    note: "Behaviour gaps: `POST …/invites` (`packages/server/src/http/invites.ts:94`) checks only `manage`. `role` is any non-empty string (`RoleSchema`, `packages/shared/src/schemas/groups.ts:21`), so `owner` or an unknown role is stored; `channelId` is never checked against the group's channels; and there is no `roleHoldsAll` subset check of the granted role (`member` when absent) against the creator. Tokens are stored in plaintext (`invites.token`, `packages/server/src/db/tables/groups.ts:199`) and looked up as given (`packages/server/src/provider/invites.ts:109`). Nothing sends `Referrer-Policy: no-referrer`: the `/invite/{token}` join-link page is the web bundle's static fallback. Untested: the `400`/`403` checks, the token's entropy, and the header.",
    context:
      "The `201` carries `token`, validated against `invite-create-response.json` (`conformance.test.ts:413`). Tokens are 256 bits from `crypto.getRandomValues` (`provider/invites.ts:21`, `:40`). No code logs a token. The listing also returns `token`, which the spec allows.",
  },
  {
    item: "On `redeem`, check the invite first (`404` unknown or expired, `409` exhausted, whoever the caller is); answer a valid invite redeemed by a caller who is already a member (the owner included) with `200`, the invite's `channelId` and their current role, changing no role and consuming no use of the invite; let a redemption whose invite names a since-deleted channel succeed, omitting `channelId`; refuse a non-member's redemption of an invite whose `role` the group no longer defines with `403`, consuming no use and creating no membership (§5.6)",
    level: "provider-must",
    covers: ["packages/server/test/invites.test.ts"],
    status: "partial",
    note: "Behaviour gap: an exhausted invite redeemed by an existing member gets `200`, not `409`, because the membership short-circuit (`packages/server/src/http/invites.ts:181`) runs before `consumeInviteUse` (`:194`). A redemption whose channel was since deleted still echoes its `channelId` (`:186`, `:203`): deleting a channel leaves `invites.channel_id` set. A non-member redeeming an invite whose `role` the group no longer defines is not refused: the use is consumed and the membership added with the dead role (`:194`, `:198`), not `403`. forumall#52 is the open fix for these. Untested: a member's or the owner's redeem → `200` with the invite's `channelId` and their current role, role and `uses` unchanged; the deleted-channel case.",
    context:
      "Tested: an expired invite → `404` (`invites.test.ts:241`), a revoked (so unknown) token → `404` (`:157`), an exhausted one → `409` for a non-member (`:222`).",
  },
  {
    item: "Give a guest provisioned through `/invites/{token}/guest` role `guest`, whatever the invite's `role`, and join it to the group even when the invite names a since-deleted channel; let a guest that left or was removed rejoin its own group (redeem or join) only as `guest`, and refuse with `403` a guest's join or redemption into any other group or after its `expiresAt` (§4.8, §5.6, §5.7)",
    level: "provider-must",
    covers: ["packages/server/test/invites.test.ts"],
    status: "partial",
    note: "Behaviour gap: `/guest` maps only `member` to `guest` and otherwise keeps the invite's role (`packages/server/src/http/invites.ts:261`), so an invite with role `admin` or a custom role provisions a guest holding it. Neither `redeem` nor `/join` knows about guest accounts: a guest that left or was removed rejoins with the invite's role (`http/invites.ts:198`) or `member` (`packages/server/src/http/membership.ts:137`), not `guest`; a guest's redeem or join into another group is accepted, not `403`; and a guest's `expiresAt` is stored (`packages/server/src/provider/guests.ts:140`) but never enforced, so an expired guest is not refused. forumall#52 is the open fix for these. Only the default-role case is tested (`invites.test.ts:263`); so is no invite naming a since-deleted channel.",
    context:
      "`/guest` joins the group without looking at the invite's channel (`http/invites.ts:275`), so a deleted channel does not block it.",
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
      "packages/server/test/message-create-semantics.test.ts",
    ],
    status: "covered",
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
    covers: ["packages/server/test/reactions.test.ts", "packages/server/test/dm-reactions.test.ts"],
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
      "packages/server/test/message-create-semantics.test.ts",
    ],
    status: "covered",
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
    item: "Support message edit (author-only; within `editUntil` when set, with no limit when absent) replacing any of `content`, `attachments`, `tags`, `mentions` and the article fields, and tombstone delete by the author or a holder of the group's `moderate` permission (§7.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/message-edit-delete.test.ts",
      "packages/server/test/message-edit-fields.test.ts",
      "packages/server/test/message-edit-dm.test.ts",
      "packages/server/test/ws-correlation.test.ts",
      "packages/shared/test/edits-media-groups.test.ts",
      "packages/server/test/hidden-channels.test.ts",
      "packages/server/test/message-edit-window.test.ts",
    ],
    status: "covered",
    context:
      "No limit when `editUntil` is absent: an article has no `editUntil` unless `ARTICLE_EDIT_WINDOW_SECONDS` is set, and edits to it are never refused for time (`message-edit-window.test.ts`).",
  },
  {
    item: "Answer an edit of a tombstone `404` (`not_found`), and a repeated delete of one `204` with no second `message.deleted` fanned out (over WebSocket, a `message.deleted` with `correlationId` and no `cursor` to the requester alone), applying the §7.1 order of checks (§7.1)",
    level: "provider-must",
    covers: [],
    status: "missing",
    note: "Not implemented: `authorizeMessageEdit` and `authorizeMessageDelete` (`packages/server/src/http/message-mutations.ts:104`, `:123`) never check `deletedAt`, so a tombstone is edited and `message.updated` fanned out, and a repeated delete re-tombstones and fans out `message.deleted` with a cursor again (`packages/server/src/http/messages.ts:199`, `packages/server/src/http/ws/messages.ts:161`). No test.",
  },
  {
    item: "Support channel reactions over `reaction.add`/`reaction.remove` and `PUT`/`DELETE …/reactions/{key}`, with the `…/reactions` listing, in the §7.1 order of checks: answer an add to a tombstone `404` (`not_found`); answer a repeated add with the existing `Reaction`, changing nothing, and over WebSocket send its `reaction.added` with `correlationId` to the requester alone, never fanned out; answer a remove on a tombstone, or one that removes nothing, `204`, and over WebSocket send that no-op's `reaction.removed` with `correlationId` to the requester alone, never fanned out (§7.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/reactions.test.ts",
      "packages/server/test/reaction-put-body.test.ts",
      "packages/server/test/ws-correlation.test.ts",
    ],
    status: "partial",
    note: "Behaviour gap: `authorizeReaction` checks only that the message exists (`packages/server/src/http/message-mutations.ts:178`), so an add to a tombstone succeeds; a repeated add is fanned out to every subscriber again (`packages/server/src/http/ws/reactions.ts:56`, `packages/server/src/http/messages.ts:276`). Untested: the tombstone cases and that a repeated add is not fanned out.",
    context:
      "A no-op remove already answers only the requester over WebSocket (`ws/reactions.ts:109`), and over REST answers `204` with no fan-out; both are tested (`reactions.test.ts:474`, `:529`). A repeated add returns the existing `Reaction` unchanged (`provider/reactions.ts:129`; `reactions.test.ts:316`, `:553`).",
  },
  {
    item: "Send the connection that issued a successful timeline or reaction command exactly one copy of the resulting event, with `correlationId`, whether or not it is subscribed to the channel (§7.1)",
    level: "provider-must",
    covers: ["packages/server/test/ws-correlation.test.ts"],
    status: "partial",
    note: "Behaviour gap: `Hub.publishToChannel` writes only to the channel's subscribers (`packages/server/src/provider/ws-hub.ts:233`), so a requester not subscribed to the channel gets no copy of its `message.created`, `message.updated`, `message.deleted` or `reaction.added`. Untested: the unsubscribed requester.",
    context:
      "A subscribed requester gets exactly one correlated copy (`ws-correlation.test.ts:43`).",
  },
  {
    item: "Accept `typing.start` only from an actor who can read the channel and holds a `post:<type>` grant there (`not_found` for a missing or unreadable channel, `forbidden` otherwise), send no acknowledgement of a successful one, and send nothing for a `typing.stop` with no active `start` (§7.1)",
    level: "provider-must",
    covers: ["packages/server/test/typing.test.ts"],
    status: "partial",
    note: "Behaviour gap: `typingRefusal` (`packages/server/src/http/ws/typing.ts:46`) requires group membership, not a `post:<type>` grant, so a member with no post grant may type; and a `typing.stop` with no active `start` is fanned out whenever the actor may type (`:276`). Untested: the `forbidden` case and the no-op stop.",
    context:
      "A missing or unreadable channel gets `not_found` (`typing.test.ts:419`); a successful `start` gets no correlated reply (it is fanned out uncorrelated).",
  },
  {
    item: "Serve channel history and replies holding messages only, tombstones included, never reactions (§7.2)",
    level: "provider-must",
    covers: [
      "packages/server/test/messages.test.ts",
      "packages/server/test/message-edit-delete.test.ts",
      "packages/server/test/conformance.test.ts",
      "packages/shared/test/schemas.test.ts",
    ],
    status: "covered",
    context:
      'The history and reply listing of messages that carry reactions hold no `Reaction` item, and a tombstoned reply stays in the reply listing (`messages.test.ts`, "history and replies hold messages only"). A tombstone stays in history (`message-edit-delete.test.ts:408`, `:569`). Both live pages validate against the spec\'s `messages-page` schema (`conformance.test.ts`), and `MessagesPageSchema`, which both routes parse with, rejects a page whose item is a `Reaction` (`schemas.test.ts`, "history and reply pages hold messages only").',
  },
  {
    item: "Accept `text/plain` and `text/markdown` bodies for every message type; store the article fields `title`, `summary` and `cover` (rejecting a `cover` that names none of the message's attachments) and ignore them on other types; store `mentions` (§5.3) and, if the provider offers the §10.1 feed, take a message's mentions from it in place of text parsing when present (§10.1)",
    level: "provider-must",
    covers: [
      "packages/server/test/message-create-fields.test.ts",
      "packages/server/test/message-edit-fields.test.ts",
      "packages/shared/test/edits-media-groups.test.ts",
      "packages/server/test/message-create-semantics.test.ts",
      "packages/server/test/message-mentions-notifications.test.ts",
    ],
    status: "covered",
    context:
      "Forumall offers the §10.1 feed, so the mentions clause binds it: a stored `mentions` list is exactly who is mentioned (`[]` nobody), and only without one is the text parsed.",
  },
];
