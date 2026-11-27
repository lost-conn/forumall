# OFSCP §12 conformance audit

Audit of Forumall `main` at `1b336ef` against the §12 Compliance Checklist of
OFSCP `main` at `598e45d` (updated for ofscp#31, `7f3e0e9`, ofscp#34, `300f6fa`, ofscp#35–#40, `e94447d`, ofscp#41, `31100ef`, and ofscp#42, `8ffa97b`) (`../ofscp/docs/ofscp_spec.md`). Every checklist line
was split into its sub-requirements and checked for (a) the behaviour in the
code and (b) a test that asserts it. The per-item coverage map itself (which
test files cover which item) lives in `packages/server/test/checklist/` and is
rendered to `CONFORMANCE.md`; this document records the audit findings and how
the gaps are grouped into pull requests.

## Status key

- **covered**: every sub-requirement is implemented and asserted by a test.
- **partial**: implemented, but some sub-requirements lack an asserting test,
  or a minor sub-requirement lacks behaviour.
- **tests only**: the behaviour is all there; asserting tests are missing.
- **behaviour**: some of what the item requires is not implemented (or is
  implemented wrongly).
- **spec question**: the spec is ambiguous; sent to the OFSCP oracle, not guessed.

`Lnn` is the line of the item inside §12 (counting from the `## 12.` heading).

## Summary

| Level | Items | covered | partial / tests only | behaviour | spec question |
|---|---|---|---|---|---|
| Provider MUST | 46 | 12 | 16 | 18 | 0 |
| Provider SHOULD | 4 | 0 | 0 | 4 | 0 |
| Provider MAY | 7 | 5 | 1 | 1 | 0 |
| Client MUST | 14 | 4 | 3 | 7 | 0 |
| Client SHOULD | 8 | 1 | 2 | 5 | 0 |

The `covered` column matches the coverage map (`CONFORMANCE.md`), which is the
authority from here on; the map folds "tests only" and "behaviour" into
`partial` or `missing`.

The old map (28 Provider + 7 Client MUST items) predated the spec PRs #23–#30;
16 Provider and 6 Client MUST items were not in it at all.

## Provider MUST

| L | Item (short) | Status | Gap | Unit |
|---|---|---|---|---|
| 5 | Password login, registration by mode (§4.1.1) | covered | Only `open` mode exists, which a provider may choose. | — |
| 6 | Bootstrap tokens (§4.2) | tests only | No test that a bootstrap token is refused on every other endpoint. | U11 |
| 7 | Device keys: register, list, revoke, `4003` (§4.7) | tests only | List item fields never asserted or schema-validated. | U11 |
| 8 | `public_key` encoding, `400` on a bad key (§4.3.2) | partial | Guest creation with a non-32-byte key untested; a verifier drops the whole keys/discovery document when one key is bad (spec question 3). | U11 |
| 9 | Signature validation, one bounded replay store (§4.5) | tests only | Full store → `503` over HTTP, replay of a provider-signed request, concurrent copies (atomic re-check) untested. | U11 |
| 10 | Outbound-request rules (§8) | tests only | Push delivery to http/private/redirecting endpoints untested; DM-forward, notification and scrape egress tested only through an injected transport. | U11 |
| 11 | Federation allow/deny on every route (§8) | behaviour | A signed request from a denied provider to discovery, the keys endpoint, `/api/tiers`, `/api/health`, `/problems/*` is answered `200`, not `403`. Untested: steps 1–5 beat the `403`, a `403`'d nonce is not recorded, unsigned reads still served with a deny list, push to a later-denied host, own authority exempt. | U4 (behaviour), U11 (tests) |
| 12 | CORS per §3.4 | tests only | No CORS test exists anywhere (`http/cors.ts` is correct by inspection). | U5 |
| 13 | WS handshake failures mirror REST, `4001` | covered | — | — |
| 14 | WS envelope and command rules | covered | — | — |
| 15 | Partial `subscribe`, subscription cap | covered | — | — |
| 16 | Keys endpoint `200` + `keys: []` (§4.6) | behaviour | An invalid handle (`a%40b`, `a%20b`) → `500` (`UserKeysResponseSchema.parse` throws, `http/user-keys.ts`); unknown vs keyless answers not compared; `actor` for a non-canonical handle is spec question 2. | U4 |
| 17 | Re-fetch on unknown `key_id`, `503` when unfetchable | covered | — | — |
| 18 | Identity mismatch rejected; `403` denied, `401` forbidden fetch | covered | — | — |
| 19 | Group and channel CRUD with permissions (§5.5) | behaviour | `GET` channel the caller can't read → `403` (must be `404`); `PATCH`/`DELETE` channel never check read access. Channel list of an unreadable group: spec question 4. | U3 |
| 20 | Membership (§5.7) | tests only | Nickname limits/clearing/404, subset rule against the target's current role, `member.updated` to the member's own connections untested. | U12 |
| 21 | Message create, every type, both transports | tests only | WS create: unreadable channel → `not_found`, `post:<type>` / `replyOnly` / `replyOnlyTo` refusals, `memo` and replies over WS; REST create in a missing group. | U9 |
| 22 | `clientMessageId` idempotency and echo | tests only | Duplicate returns the message as it now stands (edited/deleted); key is per channel; reply-only retry without `reference` → `403`. | U9 |
| 23 | Full `Message` in `message.created`/`updated`, `dm.message` | covered | — | — |
| 24 | Message edit and tombstone delete (§7.1) | behaviour | Edit/delete never check read access first: an author who lost access can still edit; a non-reader gets `403`, not `404`. "Edits never notify" untested. | U3 (behaviour), U9 (tests) |
| 25 | Bodies, article fields, `mentions` (§5.3, §10.1) | behaviour | Notifications parse the text and ignore `mentions` (known gap). No server test of `text/markdown` per message type. | U9 |
| 26 | `POST /api/media`: `target`, metadata, `thumbnail` (§5.8) | behaviour | `target` part ignored and not stored (known gap); `thumbnail` part ignored. `mime` taken from the declared part type: spec question 5. | U6 |
| 27 | Capability URLs (§5.8) | tests only | Entropy, unlisted, CORS on the media GET untested. | U5 |
| 28 | Attachment checks in a stored message (§5.8) | behaviour | "Is a local upload" not checked (no `target`, known gap "hosted-attachment checks"); an `http` `thumbnail.url` from a remote author untested. | U6 |
| 29 | `Content-Disposition` / CSP `sandbox` / `nosniff` | behaviour | `GET /api/media/{id}` sends none of them. | U5 |
| 30 | Remote uploads stable; short-lived URLs only for local; 24 h pending | behaviour | No remote uploads (no `target`), no lifecycle; met only because nothing is ever removed. | U6, U7 |
| 31 | `/api/me/groups` + `groups.updated` (§5.7) | behaviour | Not implemented (known gap). | U8 |
| 32 | `PATCH /api/me/profile` avatar rules (§6.3) | partial | Remote-upload avatar not rejected (needs `target`); the `UserProfile` response and `updatedAt` untested. | U6 |
| 33 | Users' profile/presence/groups visibility (§6.1–§6.5) | behaviour | Routes require a signature, so anonymous viewers get `401`; `…/groups` lists every membership with no tier filter; `requireParam` decodes twice, so `%25` → `500`; uniform `404` bodies untested. | U4 |
| 34 | `PUT /api/me/presence`, `PUT /api/me/privacy` | behaviour | Related: privacy lists accept a user URI and convert it (`UserRefSchema`); the ofscp schema takes canonical actors only (known gap). | U4 |
| 35 | Direct messages (§7.4) | behaviour | A remote participant can't subscribe to a `dmId` (known gap), so no `dm.*` delivery or resume for it. Non-participant subscribe → `not_found`, non-participant read → `404` where the spec says `forbidden`/`403` (spec question 8). Untested: `dm.conversation`, non-local `to`, `with` = caller, remote `PUT /api/me/dms`. | U10 |
| 36 | Contacts (§6.7) | tests only | Federated `remove` untested. | U11 |
| 37 | Provider keys and provider signing (§8.1) | covered | — | — |
| 38 | Direct-WS from remote members (§8.5) | tests only | No remote-specific test of a member blocked by tier or `view`, or of remote `since` resume (both reuse the local path). | U12 |
| 39 | Follows as pointers (§7.6) | behaviour | An unreadable channel answers `403` (see L44). | U3 |
| 40 | WS resume, `ping`/`pong` | covered | — | — |
| 41 | WS presence (§7.5) | tests only | Live `presence.update` filtering, allow/deny lists on WS, heartbeat timeout → offline, `PUT` fan-out, `presence.unsubscribe` untested. | U12 |
| 42 | Fan-out + notification endpoints | tests only | `GET` and `DELETE /api/notifications/endpoints` untested. | U12 |
| 43 | Tiers, one §11.3 rule, `unsubscribed` | behaviour | "Reading never implies posting": a non-member reader can react and type; reaction `react` override uses rank inheritance, against exact membership (§5.2). Edit/delete skip read access. | U3 |
| 44 | Unreadable channel answers as missing (§11.3) | behaviour | `403` instead of `404`/`not_found` on: channel `GET`, history, replies, reactions list, reaction add/remove (REST + WS), WS `typing`, `POST /api/me/follows`, edit/delete. | U3 |
| 45 | Unsigned → anonymous viewer, never `401` (§4.5) | behaviour | `/api/users/{userRef}/{profile,groups,presence}` require a signature. Anonymous replies and a bad signature on an anonymous route untested. | U4 |
| 46 | `private` tier | covered | — | — |
| 47 | `GET /api/tiers` | covered | — | — |
| 48 | Store `metadata` as given, `400` for an invalid object (§5.4) | covered | (Was "metadata schema registry" until ofscp#31.) | — |

## Provider SHOULD

| L | Item (short) | Status | Gap | Unit |
|---|---|---|---|---|
| 52 | `membership` on `GET` group, never publicly cacheable | behaviour | Never included (known gap). | U8 |
| 53 | Attachment caching; stop serving unreferenced uploads | behaviour | Media is `public, max-age=31536000, immutable`, no ETag (known gap); an upload is never unreferenced, including when an edit drops it (known gap). | U5 (headers), U7 (lifecycle) |
| 54 | Attachments from another origin than the web client's | behaviour | Same origin by design (one process, one port). Design decision for Joe. | — |
| 55 | Longer or no edit window for `article` | behaviour | One 900 s window for every type (known gap). | U9 |

## Provider MAY

Five of six (known providers, guest claim/merge, notification
feed/settings/Web Push, inline DM reactions, read markers) are implemented and
tested. The discover feed is partial: the item says "local + known providers",
and only local channels are compiled.

## Client MUST

| L | Item (short) | Status | Gap | Unit |
|---|---|---|---|---|
| 68 | Request signing | covered | — | — |
| 69 | Handshake before other commands | behaviour | The chat controller's `sendCommand` sends `message.create`, reactions and typing once the socket is open, before `authenticated` (server closes `4001`). | U13 |
| 70 | `registration_closed` / `invite_required` | behaviour | Not handled; no invite-token input on register or claim. | U13 |
| 71 | Derive `dmId` | covered | — | — |
| 72 | Remote channels: WS to the channel's home provider | behaviour | The chat view always uses the home socket, so a remote channel can't be opened or posted to outside the feed. | U15 |
| 73 | Client-side home feed | covered | — | — |
| 74 | All message types or fallback | tests only | The feed and DM renderers have no unknown-type test. | U14 |
| 75 | Duplicate-create `message.created` | tests only | No controller-level test of a correlated, cursor-less duplicate; WS client cursor unchanged by a cursor-less event untested. | U13 |
| 76 | Avatar upload then `PATCH` | covered | — | — |
| 77 | Attachments to home with `target` | behaviour | `uploadMedia` never sends `target`; no reuse-by-target tracking. | U13 |
| 78 | Rendering by `mime`, link allow-list | behaviour | Rendering follows the message type, not `content.mime`: `text/plain` gets inline Markdown, `text/html` is neither sanitized nor stripped, `attachment:` links are inactive, `mailto:` untested. Relative links: spec question 6. | U14 |
| 79 | `attachment:<id>`, unreferenced attachments, article title | behaviour | No `attachment:` resolution; the `title` field is ignored; title taken from any heading anywhere; reading pane shows no attachments. | U14 |
| 80 | Attachments untrusted | partial | No test that html/svg attachments never render inline; new-tab links: spec question 7. | U14 |

## Client SHOULD

| L | Item (short) | Status | Gap | Unit |
|---|---|---|---|---|
| 84 | Render metadata extensions when schemas known | behaviour | The client knows no extension schema; nothing to render yet. | — |
| 85 | Tier UX | covered | — | — |
| 86 | Federation latency and retries | partial | WS reconnect + `since` resume untested. | U13 |
| 87 | DM `to`, pointer after cross-provider send, sent history from counterparty | partial | Sent history never read from the counterparty's provider; `to` and the pointer untested. | U15 |
| 88 | Don't auto-load remote content | behaviour | Attachments of authors on other providers load automatically. | U15 |
| 89 | Set `mentions` | behaviour | Never set. | U13 |
| 90 | Membership pointer after remote join/leave | behaviour | No remote-group join, no pointer. | U15 |
| 91 | Refresh a failing attachment `url` | behaviour | Not handled. | U15 |

## ofscp#34 (`300f6fa`): `reference.provider`

ofscp#34 added four items: a message `reference` may name the provider holding
the parent, which matters for DM replies (each DM is held by its recipient's
provider). The `L` numbers are in the spec at `300f6fa`; ofscp#34 shifted the
lines after L20 in the tables above, which keep their audited numbers.

| L | Item (short) | Status | Gap | Unit |
|---|---|---|---|---|
| 21 (P MUST) | Canonical `reference.provider`; channel reply naming another provider → `400` | behaviour | `MessageReferenceSchema` has no `provider`; `authorizeReplyTarget` (`http/message-mutations.ts:254`) ignores it, so another provider is accepted and stored verbatim. No test. | U16 |
| 22 (P MUST) | Served `Reaction.reference.provider` is own authority | tests only | Never set (SHOULD omit), so met; the DM `Reaction` `reference` is never asserted (channel one is, `reactions.test.ts:337`, `:571`). | U16 |
| 65 (P MAY) | DM replies: parent check or participant home provider; listing `provider` parameter | behaviour | DM send stores `reference` unchecked (`http/dms-federation.ts:119`); listing has no `provider` and matches bare `reference.id` (`provider/dm-reactions.ts:318`). Same-provider listing tested only. | U16 |
| 74 (C MUST) | Key by (holding provider, `id`); set `reference.provider`; show unresolved parents | behaviour | DM store keys messages and reactions by bare id (`stores/dms.ts:148`, `:162`, `:317`); replies sent without `provider` (`DmsPage.tsx:1257`). An unresolved parent renders as "a message", untested. | U17 |

U16 (server: `reference.provider` in the shared schema, canonicalization, the
channel `400`, DM reply checks and the listing parameter, DM reaction test)
and U17 (client keying by provider and DM reply `provider`; follows U15's
cross-provider DM history) are new units.

## ofscp#35–#40 (`e94447d`): membership, DM participants, channel messaging, one signature identity, invite tokens

ofscp#35 spelled out group membership and invites (six new items); ofscp#36
reworded the deny and DM items; ofscp#37 clarified channel and DM messaging
(eight new items, three reworded); ofscp#38 made a request carrying both
identity headers a step-1 `401`; ofscp#39 added the approve `409` while the
group is invite-only; ofscp#40 extended the invite items (token in the `201`,
token entropy and storage, `Referrer-Policy`, deleted channels). The `L`
numbers are in the spec at `e94447d`.

| L | Item (short) | Status | Gap | Unit |
|---|---|---|---|---|
| 8 (P MUST) | Signature validation, now also both identity headers → step-1 `401` | met (U19) | Step 1 (`http/signature.ts` `readSigningHeaders`) rejects both identity headers with `401` before the deny check, on every route (`provider-signed-routes.test.ts`). The U11 test gaps (full store over HTTP, replayed provider-signed request, concurrent copies) remain. | U19, U11 |
| 10 (P MUST) | Federation deny `403`, now also for a provider-signed request to a user-signature-only route | met (U22) | A denied provider gets `403` on user-only routes too (`provider-signed-routes.test.ts`). | U22 |
| 20 (P MUST) | Owner listed as `owner`, `joinedAt` kept, stable member order | tests only | Implemented (`provider/groups.ts:130`, `provider/membership.ts:152`); no test asserts the owner's listed role, the creator's `joinedAt`, or `joinedAt` after a role change or transfer. | U12 |
| 21 (P MUST) | Repeat `join` → `202` with the pending request unchanged; `leave` by a non-member → `404`, by the owner → `409` | tests only | Repeat with a different `message` and the non-member `404` (`http/membership.ts:141`) untested. | U12 |
| 22 (P MUST) | Approve/deny on `manage` or `moderate`, no subset rule; approving a member → `200` | tests only | Implemented (`http/membership.ts:409`, `provider/membership.ts:415`); a `moderate`-only approver, the `403`s and the already-a-member approval untested. | U12 |
| 23 (P MUST) | Pending requests survive policy changes; approve → `409` while invite-only, checked first; deny allowed | behaviour | Approve never checks `effectiveJoinPolicy` (`http/membership.ts:409`). Requests do survive. No test. | U18 |
| 24 (P MUST) | Invite creation: `role`/`channelId` `400`s, subset `403`; `token` in the `201`; ≥128-bit CSPRNG tokens stored as a digest; `Referrer-Policy: no-referrer`; no token logs | behaviour | None of the `400`/`403` checks exists (`http/invites.ts:103`); tokens stored in plaintext (`db/tables/groups.ts:199`); no `Referrer-Policy` anywhere. Token in the `201` and 256-bit CSPRNG tokens are fine (`provider/invites.ts:27`). | U18 |
| 25 (P MUST) | Redeem checks the invite first; a member's redeem → `200`, current role, no use consumed | behaviour | A member redeeming an exhausted invite gets `200`, not `409` (`http/invites.ts:191` before `:204`). A deleted channel's id is still echoed (`:196`, `:213`). Member redeem untested. | U18 |
| 26 (P MUST) | Guest via `/guest` always gets role `guest` | behaviour | Only `member` maps to `guest` (`http/invites.ts:271`); an `admin` invite makes an `admin` guest. A deleted channel does not block the join. | U18 |
| 32 (P MUST) | Edit; delete by author or `moderate` | partial | Delete rule implemented and tested (`message-edit-delete.test.ts:481`); the old "no `editUntil`" gap stays. | U9 |
| 33 (P MUST) | Tombstone edit → `404`; repeated delete → `204`, no second fan-out | behaviour | No `deletedAt` check (`http/message-mutations.ts:104`, `:123`); a repeat delete fans out again. No test. | U20 |
| 34 (P MUST) | Channel reactions: tombstone `404`, repeated add and no-op remove to the requester only | behaviour | Add to a tombstone accepted (`http/message-mutations.ts:178`); a repeated add is fanned out (`ws/reactions.ts:56`, `http/messages.ts:276`). No-op remove is right and tested. | U20 |
| 35 (P MUST) | One correlated copy to the requester, subscribed or not | behaviour | `publishToChannel` writes to subscribers only (`provider/ws-hub.ts:233`). | U20 |
| 36 (P MUST) | `typing.start` needs read access and a `post:*` grant; no-op stop sends nothing | behaviour | Gate is membership (`ws/typing.ts:46`); a stop with no `start` is fanned out (`:276`). | U20 |
| 48 (P MUST) | DMs: a participant by derivation, a local user's remote conversations too | behaviour | History and reply reads decide from stored rows (`http/dms.ts:77`, `:105`), so a derivation participant with nothing stored gets `404`. Subscribe and typing already derive. | U10 |
| 53 (P MUST) | Resume: current state, deleted → `message.created` then `message.deleted`; cursors shared with REST, DM too | behaviour | No `message.deleted` after a replayed tombstone (`ws/subscriptions.ts:168`); cursor interchange untested. | U20 |
| 77 (P MAY) | DM reactions: tombstone `404`, no-op remove and repeated add emit no `dm.reaction` | behaviour | Tombstone add stored, and both no-ops fan out `dm.reaction` (`http/dm-reaction-routes.ts:102`, `:104`, `:119`). | U10 |
| 78 (P MAY) | DM edit/delete author-only; tombstone `PATCH` → `404`; repeated `DELETE` no second `dm.message` | behaviour | Inbox owner may delete others' messages (`http/dm-edit-routes.ts:153`); tombstone editable (`http/dm-events.ts:134`); repeat delete re-fans (`:195`). | U10 |
| 79 (P MAY) | DM typing for any participant; no-op stop sends nothing | behaviour | A non-participant's stop is dropped, not `not_found`; a stop with no `start` is delivered (`ws/typing.ts:259`). | U10 |
| 107 (C SHOULD) | Set `mentions`; `@handle@domain` in a DM for users off the recipient's provider | behaviour | Neither is done. | U13 |

The DM and resume items were `covered` before; both are now `partial`. New
units: U18 (server invites and join requests: creation checks, token digest
and `Referrer-Policy`, redeem order and deleted channels, guest role, approve
`409`, with tests), U19 (verifier: both identity headers → step-1 `401`), U20 (server
channel messaging per ofscp#37: tombstones, reaction no-ops, the requester's
copy, typing grant, resume of deletes, cursor tests). This PR also drops
`Reaction` from `TimelineItemSchema`, as the ofscp#37 schema does, and closes
L37 (history and replies hold messages only): tests now cover the history and
reply listing of reacted messages, a tombstoned reply, and the schema refusing
a `Reaction` item. The web client backfills each loaded message's reactions
from `…/reactions` for the first page, older pages and reply listings.

## ofscp#41 (`31100ef`): follow `groupId` and exact unread counts

ofscp#41 reworded two items. The provider derives a `Follow`'s `groupId` from
the channel (a local id, or the group's object URI on the channel's authority)
and ignores one in the `POST` body; `unreadCount` is exact, never capped, and
counts tombstones. The schema changes are descriptions only. The `L` numbers
are in the spec at `31100ef` (unchanged from `e94447d`).

| L | Item (short) | Status | Gap | Unit |
|---|---|---|---|---|
| 52 (P MUST) | Follow list as pointers, `groupId` derived from the channel | behaviour | The body's `groupId` is stored as given (`http/follows.ts:128`, `:158`); nothing derives it, so a follow without one has none. `follows.test.ts:161` asserts the echo. | U21 |
| 81 (P MAY) | Read markers by message id; `unreadCount` exact, tombstones counted | tests only | An uncapped `COUNT(*)` with no `deleted_at` filter (`provider/read-markers.ts:164`, `:183`); no test counts a tombstone. | U21 |

Both items were `covered` before; both are now `partial`. New unit: U21 (derive the `Follow` `groupId` from the channel and
ignore the body's; a test that a tombstone still counts as unread).

## ofscp#42 (`8ffa97b`): provider-signed requests to user-signature routes

ofscp#42 reworded two items. A provider-signed request from a permitted
provider, on a route that does not take provider signatures (every route of
the spec, discovery and the keys endpoint included), gets `401` after §4.5
steps 1–5 and the §8 deny check (a denied provider still gets `403`): no
discovery fetch, no signature check, no nonce recorded, and never an anonymous
viewer, `GET` group included. The replay warm-up `503` does not apply to these
unverified `403`/`401` answers. The `L` numbers are in the spec at `8ffa97b`.

| L | Item (short) | Status | Gap | Unit |
|---|---|---|---|---|
| 10 (P MUST) | Federation deny `403`; a permitted provider's signature on a user-signature route → `401`, unverified | partial (U22) | Met on every route that takes user signatures only: after steps 1–5 the deny `403`, else `401` for a provider signature, with no discovery fetch, verification or nonce, before the warm-up `503` (`provider-signed-routes.test.ts`). Left: the `/api/federation/dms` edit/delete/reaction routes still accept provider signatures for Forumall's own DM forwarding (`http/dms-federation.ts`, `http/dm-forwarding.ts`). | U23 |
| 58 (P MUST) | Anonymous viewers; `401` kept for a permitted provider's signature | met (U22) | A permitted provider's signature on an anonymous-reader route gets `401` after steps 1–5 (a digest mismatch `400`), never anonymous (`provider-signed-routes.test.ts`). | U22 |

L58 was `covered` before; it is now `partial`. New unit: U22 (verifier: one
step-1 identity check that accepts either identity header, then steps 1–5, the
deny check before the warm-up `503`, and, on a route that does not take
provider signatures, `401` for a permitted provider with no discovery fetch,
verification or nonce; tests on public, anonymous-reader and user-only routes,
in and out of warm-up). U19 (both identity headers → step-1 `401`) lands in
the same step-1 code and should go with it.

U19 + U22 landed together. They left one gap, on purpose, for its own unit.
Forumall's home provider forwards DM edits, deletes and reactions for a remote
counterparty provider-signed, so the `/api/federation/dms` edit/delete/reaction
routes still accept provider signatures. The spec rules both out: it defines no
route that takes provider signatures (§8), and "No provider forwards it" (§7.4).
New unit: U23 (client-direct DM edits, deletes and reactions; forwarding
removed).

## Units of work

Each unit is one pull request to `main`. Each updates its area's entries in
`packages/server/test/checklist/` and regenerates `CONFORMANCE.md`.

| Unit | PR scope | Items |
|---|---|---|
| U0 | Checklist map rebuilt against the spec text, per-area modules, generated `CONFORMANCE.md`; this audit. | all |
| U1 | `bun run typecheck` covers server tests (#35). | hygiene |
| U2 | Shutdown nits (#36). | hygiene |
| U3 | Hidden channels answer as missing on every surface (§11.3); read access before edit/delete; reading never implies reacting or typing. | 19, 24, 39, 43, 44 |
| U4 | Public routes: anonymous viewers on `/api/users/…`, group-tier filter, single decode, uniform `404`; signed requests to public routes run §4.5 and the federation policy; keys endpoint `500`; canonical-only privacy lists. | 11, 16, 33, 34, 45 |
| U5 | Media serving: `Content-Disposition`/CSP/`nosniff`, private `Cache-Control` + ETag, capability-URL tests; CORS test suite. | 12, 27, 29, 53 (headers) |
| U6 | Media upload `target` and `thumbnail`; local-upload check; remote uploads; remote-upload avatar. | 26, 28, 30, 32 |
| U7 | Upload references and removal: an edit, delete or avatar change unreferences; removal in bounded time after the 24 h pending window. | 30, 53 |
| U8 | `/api/me/groups` + `groups.updated`; `membership` on `GET` group. | 31, 52 |
| U9 | Message semantics: `mentions` drive notifications; edit window per type; create/idempotency/edit test gaps. | 21, 22, 24, 25, 55 |
| U10 | DM real-time for remote participants (`dmId` subscribe, delivery, resume); DM test gaps; split `http/dms.ts`. | 35 |
| U11 | Auth, keys, signature and egress test gaps; per-key unusable keys (after spec question 3). | 6–11, 36 |
| U12 | Membership, presence and notification-endpoint test gaps. | 20, 41, 42 |
| U13 | Client protocol: commands wait for `authenticated`; registration-mode errors; upload `target`; `mentions`; duplicate-create and reconnect tests. | 69, 70, 75, 77, 86, 89 |
| U14 | Client rendering by `mime`, `attachment:` links, article title, untrusted attachments. | 78, 79, 80 |
| U15 | Client remote channels and groups, cross-provider DM history, remote-author attachments, attachment refresh. | 72, 87, 88, 90, 91 |
| U16 | Server `reference.provider`: shared schema field, §2.2 canonicalization, channel `400`, DM reply checks, DM reply listing `provider` parameter, DM `Reaction.reference` test. | 21, 22, 65 (at `300f6fa`) |
| U17 | Client keying by (holding provider, `id`), DM reply `provider`, unresolved-parent test. Follows U15. | 74 (at `300f6fa`) |
| U18 | Server invites and join requests: creation `role`/`channelId` `400`s and subset `403`; token digest and `Referrer-Policy: no-referrer`; redeem checks the invite before membership and omits a deleted `channelId`; `/guest` always `guest`; approve `409` while invite-only; tests. | 23–26 (at `e94447d`) |
| U19 | Verifier: a request carrying both `X-OFSCP-Actor` and `X-OFSCP-Provider` → step-1 `401`, before the deny check; tests. | 8 (at `e94447d`) |
| U20 | Server channel messaging (ofscp#37): tombstone edit `404` and repeat-delete no-op, reaction tombstone and no-op rules, one copy to an unsubscribed requester, typing `post:*` grant and no-op stop, `message.deleted` after a replayed tombstone, cursor interchange tests. | 33–36, 53 (at `e94447d`) |
| U21 | Server follows and unread counts (ofscp#41): derive the `Follow` `groupId` from the channel, ignore the body's; tests for derivation and a tombstone counted as unread. | 52, 81 (at `31100ef`) |
| U22 | Verifier (ofscp#42): a provider signature on a route that does not take one → `401` after steps 1–5 and the deny `403`, with no discovery fetch, verification or nonce; the deny check and these answers before the warm-up `503`; tests on public, anonymous-reader and user-only routes. Pairs with U19. | 10, 58 (at `8ffa97b`) |
| U23 | DM edits, deletes and reactions to a remote counterparty (§7.4, §8.3: no provider forwards them): the web client sends them user-signed straight to the counterparty's provider (`/api/federation/dms/…`); remove `http/dm-forwarding.ts`, the home routes' forwarding branch and provider-signature acceptance (`requireActorOrProviderSignature`) on the federation DM routes, which then answer a permitted provider `401`; tests (server, web, two-provider e2e). Follows U22. | 10 (at `8ffa97b`) |

Order: U0 first (every unit edits the map). U3, U4, U5, U9, U10, U11, U13 and
U14 touch disjoint files and can run in parallel; U6 follows U4 and U5; U7
follows U6; U8, U12 and U15 follow U3.

## Spec questions and answers

Nine questions went to the OFSCP oracle. Answers (ofscp#31, merged as
`7f3e0e9`, plus Joe's decisions, which a second spec PR records):

1. L48: there is no registry in v0.1; the item now reads "On create, store
   `metadata` as given, rejecting (`400`) an invalid metadata object".
2. L16: an invalid or non-canonical handle on the keys endpoint gets `404`.
3. L8 (Joe): per key. A published key that isn't 32 bytes is ignored on its
   own; a request signed with it gets `401`, like an unknown key.
4. L19: `GET …/channels` answers like `GET` group: `404` unknown, `403`
   unreadable; channels inside stay `404`. Forumall already does this.
5. L26 (Joe): the declared part type may be recorded, but not an inline-shown
   type (non-SVG image, video, audio) the bytes don't confirm; otherwise
   `application/octet-stream`.
6. L78: scheme-less and relative links are inactive.
7. L80: a plain link to an attachment is fine; `blob:`/`data:`, `srcdoc` and
   frames are not.
8. L35 (Joe): a non-participant gets the same answer as an unknown `dmId` on
   every DM path (`404` / `not_found`), which is what Forumall does today.
9. L25: using `mentions` in place of parsing binds only providers that offer
   §10.1 feeds (Forumall does).

Also from ofscp#31: `GET /api/groups/{groupId}/members` is not an
anonymous-reader route (unsigned → `401`). Forumall answers anonymous callers
today; folded into U4.

## Design decisions for Joe


- L54 (SHOULD): serve attachments from a separate origin. It conflicts with
  the one-process, one-port self-host goal; an optional `MEDIA_ORIGIN` could
  serve the same process under a second host name.
- L84 (SHOULD): metadata rendering has nothing to render until the client
  knows an extension schema.
