# CLAUDE.md — Forumall

Forumall is a reference implementation of **OFSCP** (Open Federated Social Communications Protocol) — a single Bun monorepo that is **both an OFSCP provider (server) and its web client**, designed to be **trivially self-hostable** (one process, one port, one SQLite file). Status: **OFSCP v0.1 feature-complete and conformance-tested** (P0–P10 delivered; the WebRTC Calls epic §9 is deliberately deferred — see the Forumall board BACKLOG).

The protocol spec is the **single source of truth** and lives in the sibling repo **`../ofscp`** (`docs/ofscp_spec.md`, `schemas/v0.1/**`, conformance fixtures in `tests/`). Section refs like "§4.4.2" point there. **Treat `../ofscp` as read-only** from this repo; if you find a spec/schema inconsistency, report it and PR it against `lost-conn/ofscp` (4 such PRs already filed) — do not silently work around it.

## Monorepo layout
```
packages/shared/   OFSCP protocol primitives — signing, dmId, Zod schemas. Imported by BOTH server and web (the keystone).
packages/server/   Hono provider: HTTP + WebSocket, bun:sqlite + Drizzle. Also serves packages/web/dist as static (one process).
packages/web/      SolidJS + Vite + UnoCSS client. Consumes @forumall/shared.
e2e/               Playwright end-to-end (single- and two-provider). Boots the real server + built web bundle.
```
Workspace package names are `@forumall/{shared,server,web,e2e}`.

## Stack
Bun · Hono · bun:sqlite + Drizzle · Zod · `@noble/ed25519`/`@noble/hashes` · Argon2id (`@noble/hashes/argon2`) · SolidJS + Vite + UnoCSS + `@solidjs/router` + `@tanstack/solid-query` · Biome (lint/format) · Playwright. **All deps are pure-JS (no native build step)** — a self-host requirement; keep it that way.

## Commands (run from repo root)
- `bun install`
- `bun run typecheck` — per-package `tsc --noEmit` across all four packages.
- `bun run test` — **scoped** unit/integration via `--filter` (shared + web + server). **Use this, NOT bare `bun test`** — bare `bun test` scans into `e2e/` and pulls Playwright `*.spec.ts` into Bun's runner, producing ~7 spurious "did not expect test()" errors. Per-package: `bun test packages/server`.
- `bun run build` — vite build of the web bundle → `packages/web/dist`.
- `bunx biome check .` (or `bunx biome check --write .` to fix). Keep it clean; CI runs it.
- `bun run test:e2e` — Playwright (the fixture builds the web bundle first). `bun run test:all` = unit + e2e.
- Boot the server: `bun run packages/server/src/index.ts` (zero-config localhost boot works; set `DOMAIN` for a real deploy).

**Every authenticated change should end green on:** `bun run test` + `bun run typecheck` + `bunx biome check`. The server suite uses `app.request(...)` (HTTP) and real `Bun.serve` + `new WebSocket` (WS) — no mocks.

## `packages/shared` — protocol SSOT (byte-exact; do not casually change)
- `signing.ts` — §4.4.2 canonical string + Ed25519 `sign`/`verify`, `contentDigest`, `generateNonce`, `rfc3339Timestamp`, `signProvider`/`verifyProviderHeaders` (§8.1), `generateKeyPair`, `signDetached`/`verifyDetached`. Gated byte-for-byte against `../ofscp/tests/signing-vector.json`.
- `ws-auth.ts` — §7.1 WS-authenticate canonical string + `signWsAuthenticate`/`verifyWsAuthenticate`.
- `dm.ts` — `deriveDmId(a, b)` (§7.4, byte-exact).
- `schemas/` — Zod schemas mirroring every `../ofscp/schemas/v0.1` object + WS envelope/events. Object schemas use `.passthrough()` (forward-compat §2.3); the WS envelope accepts any `type` (never reject unknown). Inferred TS types exported alongside.

## `packages/server` — the provider
Conventions (follow them when adding features):
- **Add a table:** define it in `db/schema.ts` and append a migration to the `migrations` array in `db/migrate.ts` (forward-only, applied on boot; currently through `0021`). Greenfield — no back-compat needed.
- **Add a router:** create `http/<feature>.ts`, mount it in `http/api.ts` (under `/api`) or in `app.ts` for root paths (`/.well-known/*`, `/invite/*`, static).
- **Auth a route:** `requireSignature()` (must be authed → sets `c.var.actor = {actor,handle,keyId,domain}`), `optionalSignature()` (verifies if headers present, else anonymous — for public reads), or `requireProviderSignature()` (§8.1). All in `http/signature.ts`, which implements the **ordered §4.5 checks** (header presence → authority → ±300s skew → nonce replay → body digest → key resolution → Ed25519 verify) — order is security-critical, don't reorder.
- **Errors:** throw `AppError.{badRequest,unauthorized,forbidden,notFound,conflict,...}` from `http/errors.ts`; the central handler renders RFC 7807 `application/problem+json`.
- **Authorize:** the permission resolver is `provider/permissions.ts` — `can(action, role, group)` / `canActor(db, action, groupId, actor)` / `getMembership` / `rankOf`. Roles rank `owner(3) > admin(2) > member(1) > guest(0)`; an action is allowed if the actor's rank ≥ the min rank among the roles listed in `group.permissions[action]` (owner always allowed). Channel visibility: `provider/channels.ts` `channelVisibleTo(db, groupId, tier, actor)`.
- **Real-time:** the connection hub is `provider/ws-hub.ts` — `hub.publishToChannel(channelId, event)` and `hub.publishToActor(actor, event)`. It's on `c.var.hub`. **REST mutations must also fan out over the hub** so WS subscribers see them (e.g. REST message edit/delete publishes `message.updated`/`deleted`). WS command handlers live in `http/ws.ts`.
- **Provider helpers** (`provider/*.ts`) hold the storage + domain logic, kept separate from HTTP: `signing-key.ts` (`getProviderSigningKey`), `password.ts` (Argon2id), `bootstrap-token.ts`, `device-keys.ts` (`resolveActorKeys`, `revokeDeviceKey`), `nonce-store.ts`, `messages.ts` (`createMessage`/`listMessages` + the global monotonic `seq` cursor), `reactions.ts`, `dms.ts`, `membership.ts` (the reusable opaque-cursor codec `encodeCursor`/`decodeCursor`), `invites.ts`, `guests.ts` (`buildUserProfile`), `contacts.ts` (`areContacts`), `privacy.ts` (`getPrivacySettings`), `visibility.ts` (`canView`), `presence.ts`, `follows.ts`, `media.ts` + `storage.ts`, `notifications.ts`, `known-providers.ts`, `discover.ts`, and `federation/*`.
- Config: `config.ts` — env-driven with defaults (`PORT`, `DOMAIN`, `DATA_DIR`, `MEDIA_DIR`, `DB_PATH`, Argon2 params, `MAX_UPLOAD_BYTES`, token/cache/timing windows, `ENABLE_KNOWN_PROVIDERS`/`ENABLE_DISCOVER_FEED`, `FEDERATION_ALLOW`/`DENY`, `FEDERATION_INSECURE_LOCALHOST`). Boots with only `DOMAIN` (or nothing locally). See `.env.example`.

## `packages/web` — the client
- `lib/ofscp-client.ts` — signing HTTP client `{baseUrl, authority, actor, keyId, privateKey}` → signed `get/post/patch/delete` + bootstrap/device-key plumbing. **Use `postBinary` for binary bodies** (the JSON path UTF-8-decodes and corrupts binary, e.g. media uploads).
- `lib/ofscp-ws.ts` — WS client (signed-challenge handshake, subscribe registry, ping/pong, auto-reconnect + `since` resume) + `OfscpWsRegistry` (one client per provider host — home + foreign).
- `lib/federation.ts` — `clientForHost`/`domainOf`/`isLocalActor` for cross-provider calls.
- `lib/key-store.ts` — device private key in IndexedDB (in-memory fallback).
- `stores/*` — Solid `createStore`/`createSignal` module stores (session, chat, dms, presence, feed) + `auth-controller`/`presence-controller`.
- `components/{groups,chat,dms,social,feed}/*`, `routes/pages.tsx`, `App.tsx`. UnoCSS tokens/shortcuts in `uno.config.ts`.

## Load-bearing invariants & gotchas (read before touching these areas)
- **Signing authority ≠ transport host.** The server reconstructs the canonical string using its own `config.domain` as the authority, never the request `Host`. The web client must therefore set `authority` (HTTP) / `host` (WS) to the **provider's logical domain**, not the transport URL. The e2e harness pins `DOMAIN=localhost:<port>` so `location.host` matches. This is the whole foundation of authority-binding (§4.4.2) and federation.
- **`message.created` does NOT echo `clientMessageId`** (it's not on `MessageSchema`). Optimistic-echo reconciliation correlates on the **`correlationId`** the author's own copy echoes (= the `message.create` command frame id, §7.1). The chat controller keeps a `frameId → clientMessageId` map.
- **WS subscribe must precede the async history backfill.** The hub fans `message.created` only to *current* subscribers; register listeners + `subscribe` synchronously before awaiting history, or a fast send races ahead and the author's echo never arrives.
- **Cursor space is unified.** REST history paging and WS resume (`since`) share one global monotonic `seq` (`encodeMessageCursor`). Edits/deletes keep their original `seq` (tombstones too); resume replays messages with `seq > since` in current state (edits to messages *before* the cursor are reconciled via REST, per §7.1/§8.5).
- **DM recipient resolution is O(n) over local users** (`deriveDmId(author, u@domain) === dmId`); a non-match → 400 (inbox-poisoning guard, §8.3). DMs are stored **only in the recipient's inbox** (no sender copy); the client retains its own sent messages locally.
- **Presence/visibility filtering is per-(subject,viewer).** `canView` precedence: self → denyList → allowList → policy (`public`/`authenticated`/`sharedGroups`/`contacts`/`nobody`). Unauthorized viewers get a uniform `offline`. WS fan-out and `GET .../presence` MUST agree for the same viewer. Note: the server does not re-fan presence on a contact-accept tier crossing — the client refreshes/reloads.
- **Single-process assumptions** (fine for the self-host single-node target): in-memory nonce store, in-memory hub, `seq = MAX(seq)+1`. A multi-process deployment would need shared stores / a real sequence (interfaces are pluggable).
- **CORS is required for browser federation.** `http/cors.ts` is wildcard + **credential-less** on purpose: the Ed25519 signature is the credential, the server never trusts `Origin`/`Host`, and there are no cookies.
- **`FEDERATION_INSECURE_LOCALHOST` is dev/test only** (default off): rewrites `https://localhost:<port>` peer fetches to `http`. Production is https-only.

## Federation (P7)
Remote actors verify because the signature middleware resolves their keys from their home provider's `/.well-known/ofscp/users/{handle}/keys` (`federation/user-keys-cache.ts`) and remote provider keys from discovery (`federation/discovery-cache.ts`); both cache + re-fetch on a verify miss (§4.6/§8.1). `federation/policy.ts` `isProviderAllowed` (allow/deny, deny wins) short-circuits **before** any network fetch. `federation/http.ts` `signedProviderFetch` makes provider-signed outgoing calls. Remote real-time is **direct-WS** (§8.5): a remote member connects straight to the channel's home provider. The injectable `federationFetch` (via `createApp` deps) is how the server-level two-provider tests (`packages/server/test/helpers/two-provider.ts`) and the e2e harness route loopback peers.

## Testing & conformance
- **Conformance is automated:** `packages/shared/test/conformance.test.ts` (golden vectors) + `packages/server/test/conformance.test.ts` (21 live responses validated against the actual `../ofscp/schemas/v0.1` JSON Schemas via ajv) + `packages/server/test/checklist.test.ts` (machine-checks the §12 MUST-coverage map). The map lives in `CONFORMANCE.md` — update it when you add/cover a MUST item.
- **Playwright:** `e2e/harness/` exposes `bootServer(extraEnv)` and `startTwoProviders()`; `harness/auth.ts` `registerUser(page, baseURL, handle)`. Browser channel: bundled Chromium doesn't support this dev OS, so it uses system Chrome via `channel` — override with `PW_CHANNEL=chromium` (CI installs it); `PW_WORKERS` caps parallelism. See `e2e/README.md`.

## Self-host / deploy
`Dockerfile` (multi-stage, single process, runs as non-root, `/data` volume, `/api/health` healthcheck), `docker-compose.yml` + `Caddyfile` (auto-TLS), `.github/workflows/ci.yml`, `scripts/backup.sh`/`restore.sh` (SQLite `VACUUM INTO` hot copy + media dir), `.env.example`, `README.md` (5-minute quickstart). All state is the SQLite DB + media dir under `DATA_DIR`. Migrations run automatically on boot (upgrade path).

## Deferred
**WebRTC Calls (§9)** — 2 cards in the Forumall board BACKLOG. `call`-type channels are already modeled; the signaling (`POST …/call/{start,join,leave,end,offer,answer,ice}`, one active session per channel → 409, `call.*` WS events, TURN/ICE) + the call UI are not built. Not in the spec's Provider-MUST checklist.
