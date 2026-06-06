# OFSCP v0.1 Conformance

This document is the human-readable rendering of Forumall's continuous, automated
proof of [OFSCP v0.1](../ofscp/docs/ofscp_spec.md) compliance. Every claim below
is backed by an executing test; the machine-checkable index lives in
[`packages/server/test/checklist.test.ts`](packages/server/test/checklist.test.ts)
and **fails CI if any §12 MUST item is unmapped or a referenced test file goes
missing** — so this map cannot silently rot.

The spec (and its JSON Schemas + conformance vectors) is the single source of
truth: it lives in the sibling [`ofscp`](../ofscp) repo and is referenced by path,
never copied in.

## How compliance is proven

1. **Golden-vector conformance** ([`packages/shared/test/conformance.test.ts`](packages/shared/test/conformance.test.ts))
   asserts the shared implementation reproduces, byte-for-byte, every published
   OFSCP vector:
   - the request-signing vector (`ofscp/tests/signing-vector.json`) — canonical
     string **and** Ed25519 signature;
   - the WS-authenticate vector — canonical string + the deterministic signature
     for the published `ws-auth-challenge` / `ws-authenticate` sample inputs (no
     `ws-signing-vector.json` exists upstream yet, so it is computed against the
     authoritative sample tuple under the test key);
   - the `dmId` derivation vector (`alice@a.com` + `bob@b.com` → the §7.4 hash).

2. **Live response schema validation** ([`packages/server/test/conformance.test.ts`](packages/server/test/conformance.test.ts))
   boots a real provider (over `Bun.serve`, so the WebSocket path is live) and
   validates **21 real response bodies** against the spec's **own** JSON Schemas
   (`ofscp/schemas/v0.1/*.json`) using **ajv** (2020-12 dialect, `$ref`/`defs`
   resolved exactly as `ofscp/tests/validate-schemas.mjs` does). This is strictly
   stronger than the zod mirror: it proves the wire bytes satisfy the authoritative
   contract. Schemas validated:

   | Surface | Endpoint | Schema |
   |---|---|---|
   | Discovery doc | `GET /.well-known/ofscp-provider` | `provider-discovery.json` |
   | Tiers | `GET /api/tiers` | `tiers-response.json` |
   | User keys | `GET /.well-known/ofscp/users/{handle}/keys` | `user-keys-response.json` |
   | Known providers (opt.) | `GET /api/providers` | `providers-response.json` |
   | Discovery feed (opt.) | `GET /api/discover` | `discover-response.json` |
   | Error path | `POST /api/groups` (unsigned → 401) | `problem-details.json` |
   | Group | `POST /api/groups` | `group.json` |
   | Channel | `POST /api/groups/{g}/channels` | `channel.json` |
   | Invite | `POST /api/groups/{g}/invites` | `invite.json` |
   | Member | `POST /api/groups/{g}/join` + member list | `member.json` |
   | Message page | `GET .../messages` | `messages-page.json` |
   | Message | each item in the history page | `message.json` |
   | Reaction | `PUT .../reactions/{key}` + list | `reaction.json` |
   | Privacy | `GET /api/me/privacy` | `privacy-settings.json` |
   | Presence | `GET /api/users/{h}/presence` | `presence.json` |
   | Follow | `POST /api/me/follows` | `follow.json` |
   | Follows list | `GET /api/me/follows` | `follows-response.json` |
   | DM conversation | each item in `GET /api/me/dms` | `dm-conversation.json` |
   | DM conversations | `GET /api/me/dms` | `dm-conversations-response.json` |
   | WS message.created | realtime envelope after `message.create` | `ws/message-created.json` |
   | WS dm.message | realtime envelope after DM send | `ws/dm-message.json` |

3. **Schema-sample coverage** ([`packages/shared/test/schemas.test.ts`](packages/shared/test/schemas.test.ts))
   parses **every** `ofscp/tests/*.sample.json` fixture against the zod mirror,
   with a completeness guard that fails if a new upstream sample has no schema.

## §12 Compliance Checklist coverage map

Status legend: **covered** = exercised by an executing test; **partial** =
provider-side guarantee is tested but a client-UI aspect (web app) is out of scope
for these protocol tests, or the feature is optional.

### Provider MUST (21 items)

| # | §12 item | Tests | Status |
|---|---|---|---|
| 1 | Password-based registration and login | `auth.test.ts` | covered |
| 2 | Scoped, short-lived bootstrap tokens (§4.2) | `auth.test.ts` | covered |
| 3 | Device key registration + revocation | `device-keys.test.ts` | covered |
| 4 | Validate Ed25519 request signatures over §4.4.2 canonical string (authority binding, nonce replay) | `shared/conformance.test.ts`, `shared/signing.test.ts`, `signature.test.ts`, `nonce-store.test.ts` | covered |
| 5 | Signed WS `auth.challenge`/`authenticate` handshake (§7.1) | `shared/conformance.test.ts`, `shared/ws-auth.test.ts`, `ws.test.ts` | covered |
| 6 | Serve user public keys at `/.well-known/ofscp/users/{handle}/keys` | `conformance.test.ts`, `device-keys.test.ts` | covered |
| 7 | Group + channel CRUD with permission model (§5.5) | `groups.test.ts`, `channels.test.ts`, `conformance.test.ts` | covered |
| 8 | Group membership: join/leave, listing, roles, request approval (§5.7) | `membership.test.ts`, `conformance.test.ts` | covered |
| 9 | Message edit (author-only, `editUntil`) + tombstone delete (§7.1) | `message-edit-delete.test.ts` | covered |
| 10 | Direct messages: dmId, inbox-only storage, delivery verification, listing/reading, `dm.message` realtime (§7.4) | `shared/conformance.test.ts`, `shared/dm.test.ts`, `dms.test.ts`, `conformance.test.ts` | covered |
| 11 | Explicit contacts model (request/accept/remove, local + federated) (§6.7) | `contacts.test.ts` | covered |
| 12 | Publish provider signing keys + sign provider-to-provider requests (§8.1) | `shared/signing.test.ts`, `federation.test.ts`, `conformance.test.ts` | covered |
| 13 | Accept remote direct-WS, resolve remote keys (§4.6), enforce membership+tier, advertise `realtimeDelivery` (§8.5) | `federation-realtime.test.ts`, `federation-actor.test.ts` | covered |
| 14 | Follow list as pointers only — no server feed (§7.6) | `follows.test.ts`, `conformance.test.ts` | covered |
| 15 | WS resume (`since` replay, per-message cursors) + ping/pong (§7.1) | `ws.test.ts` | covered |
| 16 | Real-time presence over WS + §6.1 visibility, consistent with REST (§7.5) | `presence.test.ts`, `conformance.test.ts` | covered |
| 17 | Message fan-out + notification endpoints | `notifications.test.ts`, `ws.test.ts` | covered |
| 18 | Enforce tiers per channel and group | `channels.test.ts`, `groups.test.ts`, `messages.test.ts` | covered |
| 19 | Support the `private` tier | `groups.test.ts`, `channels.test.ts` | covered |
| 20 | Expose `GET /api/tiers` | `conformance.test.ts`, `server.test.ts` | covered |
| 21 | Metadata schema registry (optional entries allowed) | `shared/schemas.test.ts` | **partial** — forward-compat metadata lists (§2.3) validated end-to-end; no explicit named-schema registry endpoint is exposed (entries are OPTIONAL). |

### Client MUST (6 items)

The Forumall web client (`packages/web`) runs all protocol-critical logic
(signing, dmId derivation, WS handshake) through `@forumall/shared`, so the shared
conformance vectors are the authoritative proof for these items. Items marked
**partial** have their protocol/provider half proven here; the remaining half is
pure web-UI behavior outside the scope of these tests.

| # | §12 item | Tests | Status |
|---|---|---|---|
| 1 | Ed25519 request signing over §4.4.2 (fresh nonce, body digest) | `shared/conformance.test.ts`, `shared/signing.test.ts` | covered |
| 2 | Complete the WS signed-challenge handshake before other commands (§7.1) | `shared/conformance.test.ts`, `shared/ws-auth.test.ts` | covered |
| 3 | Derive dmId per §7.4; retain locally-sent DMs (no sender copy server-side) | `shared/conformance.test.ts`, `shared/dm.test.ts` | **partial** — dmId derivation proven by vector; client-side retention of sent DMs is a web-UI concern. |
| 4 | For remote channels, open WS to the channel's home provider + handshake there (§8.5) | `federation-realtime.test.ts` | **partial** — provider side (accept remote direct-WS + handshake) tested; the web client's home-provider WS routing is not exercised here. |
| 5 | Compose the home feed client-side from each followed channel's source (§7.6) | `follows.test.ts` | **partial** — provider guarantee (follows are pointers, no server feed) tested; client feed composition is a web-UI concern. |
| 6 | Support all message types or graceful fallback | `shared/schemas.test.ts` | covered — forward-compat parsing (§2.3): unknown message/WS types survive without throwing. |

### SHOULD / MAY (tracked, not asserted)

- **Provider MAY** — Known-providers list at `GET /api/providers` + `sharesKnownProviders` (§8.6): **implemented & schema-validated** (`conformance.test.ts`, `discovery-feed.test.ts`).
- **Provider MAY** — Discovery feed at `GET /api/discover` + `discoverFeed` (§11.2): **implemented & schema-validated** (`conformance.test.ts`, `discovery-feed.test.ts`).
- **Client SHOULD** — Render metadata extensions when schemas known: web-UI concern, not covered by protocol tests.
- **Client SHOULD** — UX for tiers (access + discoverability): web-UI concern.
- **Client SHOULD** — Handle federation latency + retries: partially exercised by federation tests on the provider side.

## Summary

- **27** §12 MUST items (21 Provider, 6 Client): **all mapped to executing tests.**
- **23** fully covered, **4** partial (each partial is an honest provider-tested /
  web-UI-untested split, or an optional feature — see notes above). **No MUST item
  is unmapped or failing.**
- **21** live response bodies validated against the spec's own JSON Schemas.
- **3** golden vectors (request-signing, WS-authenticate, dmId) reproduced
  byte-for-byte.

## Running the suite

```sh
# Golden vectors + live schema validation + the checklist index:
bun test packages/shared/test/conformance.test.ts \
         packages/server/test/conformance.test.ts \
         packages/server/test/checklist.test.ts

# Full unit/integration suite (still green):
bun run test
```
