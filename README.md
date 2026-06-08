# Forumall

**A self-hostable [OFSCP](https://github.com/lost-conn/ofscp) provider _and_ web client in one.**

Forumall is a reference implementation of the
[Open Federated Social Communications Protocol (OFSCP) v0.1](https://github.com/lost-conn/ofscp/blob/main/docs/ofscp_spec.md):
a single program that is **both** the server (an OFSCP provider — groups,
channels, messaging, DMs, presence, follows, and cross-provider federation)
**and** the client (a SolidJS web app served by that same server). It is built to
be **trivially self-hostable by a hobbyist**: one process, one SQLite file, one
container, automatic HTTPS.

- One process, one port, one SQLite file — no Postgres, Redis, S3, or external
  service required.
- Boots with **zero configuration**; a real deployment only needs you to set
  `DOMAIN`.
- `docker compose up -d` behind [Caddy](https://caddyserver.com) for automatic
  Let's Encrypt TLS.
- Federates with other OFSCP providers over signed provider-to-provider requests.

> Status: this is a reference/hobbyist implementation tracking OFSCP **v0.1**.
> See [`CONFORMANCE.md`](CONFORMANCE.md) for the continuously-verified §12
> "Provider/Client MUST" coverage and [`PLAN.md`](PLAN.md) for the build plan.

---

## Deploy in 5 minutes (Docker + auto-HTTPS)

You need a host with Docker, and a DNS name pointing at it.

```sh
git clone <this repo> && cd forumall

cp .env.example .env
# edit .env: set DOMAIN to your real public hostname, e.g. forum.example.com

docker compose up -d
```

Point your domain's DNS **A/AAAA record at the host**, make sure ports **80 and
443** are reachable from the internet, and Caddy will obtain + renew a Let's
Encrypt certificate for `DOMAIN` automatically. Within a minute you're live at
`https://<your-domain>` — the web client is served at the root and the OFSCP API
under the same origin.

That's the whole deploy. The first boot generates the provider signing key,
creates and migrates the SQLite database, and creates the media directory — all
automatically, no setup command.

### Local / no-domain testing (plain http://)

Without a public domain Caddy can't complete the ACME challenge. For a local
smoke test, set `DOMAIN=localhost` in `.env` and switch the Caddy site block to
the documented plain-`http://` override in [`Caddyfile`](Caddyfile), then browse
`http://localhost`. (Federation requires real HTTPS — see below — so the
localhost path is for trying the single-provider experience only.)

You can also skip Docker entirely for local testing — see **Run from source**.

### Deployment modes

The default is **combined**: one process serves the OFSCP API + WebSocket **and**
the web client at the same origin (the 5-minute deploy above). You can also split
the two when you'd rather host them apart:

- **Combined** (default) — `SERVE_STATIC=true`. Provider and UI in one process,
  one port, one origin. Nothing to configure.
- **Provider-only** — set `SERVE_STATIC=false`. The process serves only `/api`
  (HTTP + WS); non-API routes `404`. Host the client elsewhere. CORS is wildcard
  and credential-less (the Ed25519 signature is the credential, not a cookie), so
  a browser client on another origin calls the API directly.
- **Client-only** — build the web bundle pointed at your provider and host the
  static `packages/web/dist` on any static host / CDN:

  ```sh
  VITE_PROVIDER_HOST=forum.example.com bun run build
  # deploy packages/web/dist/ to your static host
  ```

  `VITE_PROVIDER_HOST` bakes in the provider the client targets by default; users
  can still override it on the first-run connect screen. Without it the client
  defaults to its own origin (correct for the combined mode).

---

## Run from source (Bun, for development)

Forumall is a [Bun](https://bun.sh) workspace monorepo.

```sh
bun install

# Dev: server (:3000) + web client (:5173, HMR) together
bun run dev

# Or just the server (serves the API; build the web bundle separately for the UI)
bun run --filter '@forumall/server' dev
bun run build            # builds packages/web/dist, which the server serves
```

With **no env vars at all** the server boots on `http://localhost:3000`, writes
its state under `./data`, and logs a startup summary plus a warning that `DOMAIN`
is unset (so you don't accidentally federate under a localhost authority). To run
against a real authority, set `DOMAIN` (and optionally `PORT`).

The `:5173` dev client proxies `/api` (HTTP + WS) to the server (override the
upstream with `VITE_PROXY_TARGET`). Because the client signs with its own origin
as the authority (§4.4.2), run the server with `DOMAIN=localhost:5173` when
developing against the `:5173` client so signatures verify; or open the server
directly at `http://localhost:3000`, which is served same-origin.

### Repo layout

```
packages/
  shared/   OFSCP protocol core: Ed25519 signing/verify, canonical strings, dmId, Zod schemas
  server/   Hono provider: routes, WebSocket, Drizzle/SQLite, auth, federation; serves the web build
  web/      SolidJS client (consumes packages/shared for signing)
e2e/        Playwright suite (single-provider + two-provider federation)
```

---

## Configuration

**Only `DOMAIN` matters for a real deployment**; every other variable has a safe
default and may be left unset. [`.env.example`](.env.example) documents the full
set with one-line descriptions and defaults. The authoritative source is
[`packages/server/src/config.ts`](packages/server/src/config.ts).

Highlights:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOMAIN` | `localhost:<PORT>` | Public authority / OFSCP `iss` + the TLS hostname. **Set this.** |
| `PORT` | `3000` | In-container listen port (Caddy proxies to it). |
| `DATA_DIR` | `./data` (`/data` in Docker) | Root of all state (DB + media). |
| `SERVE_STATIC` | `true` | Serve the web client (combined mode); `false` = provider-only. See [Deployment modes](#deployment-modes). |
| `MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | Max attachment size (advertised + enforced). |
| `CONTACT` | _(unset)_ | Admin contact published in discovery. |
| `FEDERATION_ALLOW` / `FEDERATION_DENY` | empty (open) | Federation allow/deny lists. |
| `ENABLE_KNOWN_PROVIDERS` / `ENABLE_DISCOVER_FEED` | `false` | Optional discovery features. |

A bad value fails fast at boot with a clear, per-variable message (e.g. an
out-of-range `PORT` or a non-numeric `MAX_UPLOAD_BYTES`) — the server won't start
silently misconfigured.

---

## Backup & restore

A provider's **entire state is two things** under `DATA_DIR`:

1. the SQLite database file (`forumall.sqlite`) — accounts, groups, channels,
   messages, DMs, keys, everything; and
2. the `media/` directory — uploaded attachments.

Back up those two and you can restore the provider anywhere.

The database runs in WAL mode, so don't just `cp` it while the server is up. Use
the provided scripts, which take a **consistent hot copy** of the DB via SQLite
`VACUUM INTO` (safe against a live database) and archive it with the media dir:

```sh
# Backup (server can stay running) → ./backups/forumall-backup-<timestamp>.tar.gz
scripts/backup.sh                       # uses ./data, writes ./backups
scripts/backup.sh /path/to/data /path/to/backups

# Restore (STOP the server first — you're overwriting its live DB)
scripts/restore.sh ./backups/forumall-backup-XXXX.tar.gz
scripts/restore.sh <backup.tar.gz> /path/to/data
```

### With the Docker named volume

The compose stack keeps state in the `forumall_data` named volume. Run the
scripts inside a throwaway container that mounts it:

```sh
# Backup
docker compose run --rm --no-deps \
  -v "$PWD/scripts:/scripts" -v "$PWD/backups:/backups" \
  app bash /scripts/backup.sh /data /backups

# Restore
docker compose stop app
docker compose run --rm --no-deps \
  -v "$PWD/scripts:/scripts" -v "$PWD/backups:/backups" \
  app bash /scripts/restore.sh /backups/forumall-backup-XXXX.tar.gz /data
docker compose start app
```

### Continuous replication (optional)

For point-in-time / off-site durability, run
[Litestream](https://litestream.io) against `forumall.sqlite` to stream the WAL
to S3-compatible storage continuously. It's an optional upgrade — the scripts
above are enough for routine snapshots — and you'd still back up `media/`
separately.

---

## Upgrades

Forumall migrations are **forward-only and run automatically on every boot**, so
upgrading is just: get the new code and restart.

```sh
# Docker
docker compose pull        # or: docker compose build --pull
docker compose up -d

# From source
git pull && bun install
# restart your process
```

On the next boot the server applies any new schema migrations idempotently (it
logs `applied migrations: …`) and continues. Take a backup first if you want a
safety net; a backup from an older version restores cleanly onto a newer image
because migrations run on the restored DB.

---

## Federation prerequisites

To federate with other OFSCP providers, this provider must be reachable by peers
over the public internet:

- **A real public HTTPS domain** set as `DOMAIN` (this is the OFSCP signing
  authority / `iss`; peers verify your provider-signed requests against it).
- Your discovery document at `https://<DOMAIN>/.well-known/ofscp-provider` and
  your users' key endpoints at
  `https://<DOMAIN>/.well-known/ofscp/users/{handle}/keys` must be reachable by
  peers (the Docker + Caddy setup serves these by default).
- Optionally scope who may federate with `FEDERATION_ALLOW` / `FEDERATION_DENY`
  (empty = open).

`FEDERATION_INSECURE_LOCALHOST` is a **dev/testing-only** flag that lets two
providers federate over loopback without TLS; never enable it on a public host.

---

## Documentation

- [`PLAN.md`](PLAN.md) — north stars, stack, and the phased build plan.
- [`CONFORMANCE.md`](CONFORMANCE.md) — the continuously-verified OFSCP §12
  MUST-item coverage map (golden vectors + live schema validation).
- [`e2e/README.md`](e2e/README.md) — the Playwright end-to-end suite
  (single-provider + two-provider federation).
- [`.env.example`](.env.example) — every supported environment variable.
- [OFSCP v0.1 spec](../ofscp/docs/ofscp_spec.md) — the protocol Forumall
  implements.

## Development

```sh
bun run typecheck     # tsc across all packages
bun run lint          # Biome
bun run test          # unit + integration + conformance
bun run test:e2e      # Playwright end-to-end
bun run test:all      # everything
```

CI runs all of the above on every push/PR (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
