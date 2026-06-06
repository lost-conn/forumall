# Forumall — Build Plan (delivered)

> **Status: delivered.** The plan below was executed end-to-end (P0–P10) — see git history and the **Forumall** board for the per-card record. This file is kept as the historical roadmap; for living documentation use:
> - **`CLAUDE.md`** — architecture, commands, conventions, and the load-bearing invariants (start here for development).
> - **`README.md`** — what Forumall is + self-host quickstart.
> - **`CONFORMANCE.md`** — the OFSCP §12 MUST-coverage map + schema-validation status.
>
> **Not built (deliberately deferred):** the WebRTC **Calls** epic (§9) — 2 cards remain in the board BACKLOG. Not in the spec's Provider-MUST checklist.

Forumall is a reference **OFSCP** ([Open Federated Social Communications Protocol](../ofscp/docs/ofscp_spec.md)) implementation: one project that is **both an OFSCP provider (server) and a web client**, designed to be **trivially self-hostable by hobbyists**.

## North stars (all met)
1. **Spec-compliant** — every OFSCP §12 Provider-MUST / Client-MUST item for v0.1 (calls excepted, deferred). Continuously verified against the `../ofscp` golden vectors + JSON Schemas (`CONFORMANCE.md`).
2. **Self-host in one command** — one process, one port, one SQLite file; no Postgres/Redis/S3. `docker compose up` with Caddy auto-TLS, or `bun run packages/server/src/index.ts`.
3. **Verifiable in layers** — unit + integration (HTTP/WS against an in-process server) + Playwright e2e (single- and two-provider) + conformance.

## Stack
Bun · Hono · bun:sqlite + Drizzle · Zod · `@noble/ed25519`/`@noble/hashes` + Argon2id · SolidJS + Vite + UnoCSS + `@solidjs/router` + `@tanstack/solid-query`. Pure-JS deps (no native build step). Monorepo: `packages/{shared,server,web}` + `e2e/`; the **`shared`** package (OFSCP signing/dmId/Zod schemas) is imported by both server and web.

## Phases as delivered
- **P0** monorepo scaffold + tooling.
- **P1** protocol core in `shared` (request signing, WS-auth, dmId — golden-vector gated; Zod schemas mirroring all ofscp fixtures).
- **P2** Hono+SQLite provider, discovery + provider key, Argon2id auth + bootstrap tokens, device keys, §4.5 signature-verification gate.
- **P3** groups/channels CRUD + permission model, membership/roles/requests, invites + guest accounts.
- **P4** message store + history, WebSocket backbone + hub, create/fan-out/idempotency, edit/delete tombstones, resume, reactions, typing, media upload.
- **P5** direct messages (deterministic dmId, inbox-only, no sender copy).
- **P6** presence, privacy + visibility resolver, contacts, follows.
- **P7** federation: provider-signed requests, remote key resolution + cache, allow/deny policy, remote channel direct-WS, notification webhooks, known-providers + discovery feed.
- **P8** SolidJS + UnoCSS client: auth/onboarding, groups, live chat, DMs, presence/contacts/privacy, home feed + discovery.
- **P9** single- + two-provider Playwright e2e + conformance suite.
- **P10** GitHub Actions CI, single-container Docker + Caddy auto-TLS, backup/restore, README/self-host polish.
