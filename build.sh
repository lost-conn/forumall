#!/bin/sh
# jkbase build script for Forumall — see docs/deploy-jkbase.md.
#
# Runs inside the `bun.ext4` build VM (Bun + Node + glibc), chrooted in a
# writable overlay of the toolchain. The build-runner sets:
#   SRC=/src    read-only source snapshot (this repo, minus node_modules/.git)
#   OUT=/out    artifact drive — we write rootfs.tar.gz + manifest.json here
#   CACHE=/cache  optional per-project cache
#   cwd=/work   writable scratch
#
# Two phases on a networked build: `fetch` (network up via the egress proxy)
# then `compile` (network sealed off). With no proxy it's invoked once with no
# argument, so each phase guards on "$1" being its own name OR empty.
set -eu

phase="${1:-}"
APP=/work/app
ROOTFS=/work/rootfs
BUN=/usr/local/bin/bun

# ---- fetch: copy source to a writable tree and install deps (NEEDS network) --
if [ "$phase" = fetch ] || [ "$phase" = "" ]; then
    echo "[forumall] fetch: installing dependencies"
    rm -rf "$APP"
    mkdir -p "$APP"
    cp -a "$SRC"/. "$APP"/
    cd "$APP"
    "$BUN" install --frozen-lockfile
fi

# ---- compile: build web bundle + server binary, assemble rootfs (NO network) -
if [ "$phase" = compile ] || [ "$phase" = "" ]; then
    cd "$APP"

    echo "[forumall] compile: building web bundle (Node-driven Vite)"
    # Vite must run under Node — Bun's baseline build mis-resolves solid-refresh's
    # Babel module (same reason the Dockerfile drives Vite with Node).
    ( cd packages/web && node node_modules/vite/bin/vite.js build )

    echo "[forumall] compile: compiling the server to a standalone binary"
    # A single self-contained executable: embeds the Bun runtime + all server JS,
    # so the runtime rootfs stays small enough for the build VM's output drive
    # (a full `bun run` tree with node_modules would not fit).
    "$BUN" build packages/server/src/index.ts --compile --outfile "$APP/forumall"

    echo "[forumall] compile: assembling runtime rootfs"
    rm -rf "$ROOTFS"
    mkdir -p "$ROOTFS"/app/web "$ROOTFS"/proc "$ROOTFS"/sys "$ROOTFS"/dev \
             "$ROOTFS"/tmp "$ROOTFS"/data "$ROOTFS"/etc
    cp "$APP/forumall" "$ROOTFS/app/forumall"
    chmod 0755 "$ROOTFS/app/forumall"
    # Static web client, served at runtime via WEB_DIR.
    cp -a "$APP/packages/web/dist" "$ROOTFS/app/web/dist"
    # CA roots for outbound TLS (federation: fetching remote provider/user keys).
    if [ -d /etc/ssl ]; then cp -a /etc/ssl "$ROOTFS/etc/ssl"; fi

    # The compiled binary is dynamically linked (glibc/libstdc++); copy its
    # shared-object closure + the ELF interpreter into the rootfs at the same
    # absolute paths. A statically linked binary yields an empty list — fine.
    ldd "$ROOTFS/app/forumall" 2>/dev/null \
        | grep -oE '/[^ ]+\.so[^ ]*' | sort -u \
        | while read -r lib; do
            [ -e "$lib" ] || continue
            dest="$ROOTFS$(dirname "$lib")"
            mkdir -p "$dest"
            cp -aL "$lib" "$dest/"
        done

    echo "[forumall] compile: writing artifacts"
    tar -czf "$OUT/rootfs.tar.gz" -C "$ROOTFS" .

    # cmd / working_dir / env for the runtime. port, health_check, and volumes
    # come from jkbase.toml and are merged by the platform.
    #
    # DOMAIN is the signing authority the server binds every request signature to
    # (OFSCP §4.4.2); it MUST equal the public host the browser loads. It's baked
    # here because the platform does not yet inject project secrets into the
    # container env. For the default jkbase.app subdomain that's
    # "<project>.jkbase.app" — change it (and redeploy) for a custom domain.
    cat > "$OUT/manifest.json" <<'JSON'
{
  "cmd": ["/app/forumall"],
  "working_dir": "/app",
  "env": {
    "NODE_ENV": "production",
    "DATA_DIR": "/data",
    "MEDIA_DIR": "/data/media",
    "WEB_DIR": "/app/web/dist",
    "DOMAIN": "forumall.jkbase.app"
  }
}
JSON
fi
