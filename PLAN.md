# Forumall — Build Plan

Forumall is a reference **OFSCP** ([Open Federated Social Communications Protocol](../ofscp/docs/ofscp_spec.md)) implementation: a single project that is **both a provider (server) and a client (web app)**, designed to be **trivially self-hostable by hobbyists**.

This is a clean greenfield restart. The spec lives in the sister repo `../ofscp` (spec v0.1, JSON schemas under `schemas/v0.1`, and conformance fixtures under `tests/` — notably `tests/signing-vector.json`).

## North stars

1. **Spec-compliant.** Satisfy every item in the OFSCP §12 "Provider MUST" / "Client MUST" checklist for v0.1.
2. **Self-host in one command.** One process, one port, one SQLite file. No Postgres, Redis, S3, or external services required to run a working provider+client. `docker compose up` (with Caddy auto-TLS) or `bun run start`.
3. **Verifiable in layers.** Every feature ships with tests: unit (protocol/logic), integration (HTTP/WS against an in-process server), e2e (Playwright driving the real web client against a real provider), and conformance (golden vectors + schema fixtures from `../ofscp`).

## Stack

| Concern | Choice | Self-host rationale |
| --- | --- | --- |
| Runtime / pkg mgr | **Bun** workspaces | One toolchain, fast, native SQLite + test runner |
| HTTP + WebSocket | **Hono** | Tiny, runs HTTP and WS in one process |
| DB | **bun:sqlite + Drizzle ORM** | Single file, no DB server to operate |
| Validation / types | **Zod** (schemas mirror `ofscp/schemas/v0.1`) | One source of truth for types + runtime validation |
| Crypto | **@noble/ed25519**, **@noble/hashes**, Argon2id | Pure-JS, no native build step |
| Frontend | **SolidJS + Vite + UnoCSS + @solidjs/router + @tanstack/solid-query** | — |
| Nonce/replay store | in-memory (pluggable) | No Redis for the single-node default |
| Media storage | local filesystem (pluggable) | No object store required |
| TLS / deploy | Caddy reverse proxy (auto-TLS) + single container | One command, automatic certs |

## Monorepo layout

```
forumall/
  packages/
    shared/   # OFSCP protocol: signing, canonical strings, dmId, Zod schemas — imported by BOTH server and web
    server/   # Hono provider: routes, WS, Drizzle, auth, federation; also serves web build as static
    web/      # SolidJS client; consumes packages/shared for signing
  e2e/        # Playwright; can boot 1 or 2 providers (federation)
```

The **`shared` package is the keystone**: one Ed25519 signing/verification + dmId + schema implementation used by the provider to verify and by the client to sign. This is the main win of a single-language monorepo over a split client/server.

## Protocol-critical, do-first

Per the OFSCP signing strategy: the **request-signing canonical string (§4.4.2)** and **dmId derivation (§7.4)** are byte-exact and catastrophic if wrong (a mismatch silently 401s every request / poisons DM routing). They are built and locked against the published golden vectors **before any routes or UI**.

## Phases (each phase is independently testable)

- **P0 — Foundation:** monorepo scaffold, tooling, CI, single-container build.
- **P1 — Protocol core (`shared`):** request signing + verify (golden-vector gated), WS-auth canonical string, dmId, content-digest/nonce helpers, Zod schemas validated against `ofscp` fixtures.
- **P2 — Provider skeleton + auth:** Hono+SQLite skeleton, discovery doc + provider signing key + `/api/tiers`, register/login (Argon2id) + bootstrap tokens, device-key registration + keys endpoint + revocation, signature-verification middleware (ordered §4.5 checks + nonce replay).
- **P3 — Groups/channels/membership:** group CRUD + permission model, channel CRUD + tier enforcement, membership (join/leave/list/roles + request-approval), invites/join-links + guest accounts.
- **P4 — Messaging (REST + WS):** message store + paged history, WS transport (envelope, handshake, subscribe, ping/pong), create+fan-out+idempotency, edit/delete tombstones, reactions, typing, resume (`since`), media upload.
- **P5 — Direct messages:** delivery endpoint + dmId verification + inbox-only storage, listing/reading, `dm.message` real-time.
- **P6 — Presence / privacy / contacts / follows:** WS presence + visibility filtering, privacy settings + profile/presence/membership endpoints, contacts (local + federated), follows + client-composed home feed.
- **P7 — Federation:** provider-signed requests + signing identity, remote key resolution + cache/re-fetch, remote channel join + direct-WS remote subscribe, notification webhooks, known-providers + discovery feed (optional).
- **P8 — Web client (Solid + UnoCSS):** app shell + signing client, auth/onboarding (device-key gen + local key storage), groups/channels, chat (live + reactions + typing + edit/delete + optimistic echo), DMs, presence/contacts/privacy, home feed, discovery/browse.
- **P9 — E2E + conformance:** Playwright single-provider round trip, two-provider federation e2e, conformance suite (golden vectors + schema fixtures in CI).
- **P10 — Self-host polish:** one-command deploy, env config + first-run setup, backup/restore, docs.
- **Backlog — Calls (§9):** WebRTC signaling, TURN/ICE, call lifecycle + UI (deferred — not in the spec's Provider-MUST checklist).

Granular work is tracked as cards on the **Forumall** board. Card titles are phase-prefixed (`P1 · …`) and each card lists its acceptance criteria + test layer.
