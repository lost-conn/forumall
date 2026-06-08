# Deploying Forumall on jkbase

[jkbase](https://jkbase.app) runs each project as a server container in its own
Firecracker microVM. Forumall ships two files for it:

- **`jkbase.toml`** — the deploy manifest: one Bun server container, a `/data`
  volume, and a catch-all route (Forumall serves API + WebSocket + the web
  client from one process).
- **`build.sh`** — runs inside jkbase's build VM: `bun install` → Node-driven
  Vite build → `bun build --compile` to a standalone binary → assemble a lean
  runtime rootfs + `manifest.json`.

## Prerequisites (platform side)

Forumall needs platform support that landed in jkbase via
**joeleaver/jkbase#3**. On the jkbase host:

1. **A Bun toolchain image.** Bake and install it once:
   ```bash
   # in the jkbase checkout
   ./tools/build-bun-toolchain.sh
   cp .firecracker/toolchains/bun.ext4 "$DATA_DIR/toolchains/bun.ext4"
   ```
   `language = "bun"` in `jkbase.toml` selects it.

2. **Build-VM limits large enough for a Bun monorepo.** PR #3 raises the
   defaults (2 GiB scratch / 512 MiB output / 1.5 GiB mem); override per host if
   needed:
   ```bash
   JKBASE_BUILD_SCRATCH_MIB=2048 JKBASE_BUILD_OUTPUT_MIB=512 \
   JKBASE_BUILD_MEM_MIB=1536 jkbase-server …
   ```

3. **Egress allowlist permits `registry.npmjs.org`** (the build VM fetches deps
   through the default-deny egress proxy during the `fetch` phase).

## Deploy

```bash
jkbase project create forumall
jkbase deploy
```

Live at `https://forumall.jkbase.app`. `jkbase deploy` tars the repo (minus
`node_modules`/`.git`), the build VM runs `build.sh`, and the resulting rootfs
boots as the server container.

## How it maps

| Forumall | jkbase |
|---|---|
| `PORT` (3000) | injected from `jkbase.toml` `port` |
| `/api/health` | `health_check.path` |
| SQLite + media under `/data` | the `data` volume (persists across deploys) |
| web client (`packages/web/dist`) | shipped in the rootfs, served via `WEB_DIR` |
| API + WebSocket + static | the one process, all routes |

## The DOMAIN caveat (important)

Forumall binds every request signature to `DOMAIN` (OFSCP §4.4.2), and it **must
equal the public host the browser loads** — otherwise every signature 401s.

`build.sh` **bakes `DOMAIN=forumall.jkbase.app`** into `manifest.json`, because
jkbase does not yet inject project secrets into the container env (`jkbase secret
set` is stored but not wired to the runtime). Consequences:

- Default `forumall.jkbase.app` subdomain → works out of the box.
- **Custom domain** → edit the `DOMAIN` value in `build.sh` and redeploy (until
  the platform wires secret→env injection).

## Notes / limitations

- **WebSockets** require the proxy WS-upgrade support from
  joeleaver/jkbase#2. Without it, real-time (live messages, presence) won't work
  — REST history still loads.
- The server binary is produced with `bun build --compile`; `build.sh` copies
  its glibc/libstdc++ closure into the rootfs (via `ldd`). Validate a fresh
  build boots and `/api/health` returns 200 the first time on a real VM.
- Self-hosting outside jkbase is unchanged — see the repo `Dockerfile` /
  `docker-compose.yml`.
