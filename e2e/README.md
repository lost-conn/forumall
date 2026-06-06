# Forumall end-to-end tests

Playwright suite that drives the real SolidJS client against a real, ephemeral
`@forumall/server`. Each test boots its own single provider on a random port
against a throwaway temp `DATA_DIR`, serves the production-built web bundle
(`packages/web/dist`), runs the flow, then tears the server down and removes the
temp dir. Nothing is shared between tests except the one-per-worker web build.

## Specs

- `tests/auth.spec.ts` — connect / register / device keys / logout + revocation.
- `tests/groups.spec.ts` — group + channel CRUD, tiers, join policies, invites.
- `tests/chat.spec.ts` — live messaging, reactions, typing, edit/delete, media.
- `tests/dms.spec.ts` — §7.4 / §8.3 direct messages across two users.
- `tests/social.spec.ts` — profiles / follows / social graph.
- `tests/feed.spec.ts` — home + discover feed (the discover feed is gated, see
  `ENABLE_DISCOVER_FEED` below).
- `tests/journey.spec.ts` — **consolidated single-provider smoke**: one test that
  walks register → create group → create channel → post → second user joins and
  sees it live → react → edit/delete → DM, proving the whole stack is wired
  together. The per-feature specs above own the exhaustive coverage.

## Running

From the repo root:

```sh
bun run test:e2e      # the full Playwright suite (builds the web bundle first)
bun run test:all      # bun test (unit/integration) across packages + the e2e suite
```

or from this directory:

```sh
bunx playwright test                 # whole suite
bunx playwright test tests/journey.spec.ts   # just the smoke journey
```

The harness builds `packages/web/dist` once per worker process before the first
test boots a server, so a clean checkout needs no manual build step.

## Browser channel caveat

This environment's OS is newer than the Playwright-bundled Chromium build
supports, so the downloadable `chromium` is unavailable. The config therefore
drives the **system-installed Google Chrome** via the `chrome` channel
(`/usr/bin/google-chrome`). On a CI image where the bundled Chromium works (or a
different system browser is installed), override the channel:

```sh
PW_CHANNEL=chromium bun run test:e2e   # once Playwright supports the OS
PW_CHANNEL=msedge   bun run test:e2e   # or any other installed channel
```

CI must have a matching browser available — either install Google Chrome and
keep the default `chrome` channel, or run `bunx playwright install chromium` and
set `PW_CHANNEL=chromium`.

## Env knobs

| Var | Default | Purpose |
| --- | --- | --- |
| `PW_WORKERS` | `4` | Worker-pool cap. Each worker boots its own heavyweight server, so the pool is capped (below the default ~½-core fan-out) to avoid oversubscribing a high-core machine and flaking on boot/registration timeouts. Lower it on small CI runners. |
| `PW_CHANNEL` | `chrome` | Playwright browser channel (see the caveat above). |
| `ENABLE_DISCOVER_FEED` | unset (OFF → 404) | Server feature toggle for the discover feed. The feed spec boots a server with this set; off by default. |
| `WS_PING_INTERVAL_MS` | `1000` | WS heartbeat interval the harness pins so presence/idle e2e observes disconnect→offline quickly. |
| `WS_IDLE_TIMEOUT_MS` | `3000` | WS idle-sweep timeout (fallback for ungraceful drops). |

## Setup / teardown

Setup and teardown are deterministic and per-test:

- a free TCP port is chosen by binding to `:0` (`harness/boot-server.ts`),
- `DATA_DIR` is a fresh `mkdtemp` dir, removed on stop (and on boot-timeout /
  early-exit error paths too),
- the server child is killed (`SIGTERM`, `SIGKILL` on timeout) when the
  `appServer` fixture tears down,
- each spec closes its second browser context (user B) at the end.

The Playwright process exits cleanly with no leaked servers, sockets, or temp
dirs.
