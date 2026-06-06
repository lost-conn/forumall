# Forumall single-container build.
#
# One image, one process: `bun run packages/server/src/index.ts` serves the
# OFSCP API *and* the built Solid web client (packages/web/dist) on $PORT.
# State (SQLite + media) lives under /data, mounted as a volume.
#
# Build note: the web bundle is produced with NODE-driven Vite, not Bun. The
# official `oven/bun` images ship Bun's *baseline* (no-AVX2) build for CPU
# portability, and that baseline build mis-resolves `solid-refresh`'s package
# `exports` during `vite build` ("Cannot find module '../dist/babel.cjs'").
# Node resolves it correctly, so we run Vite under Node. Everything else (deps,
# the server runtime) uses Bun. The host's AVX2 Bun builds fine, which is why
# `bun run build` works locally but not in this image — see the report.

# ---------------------------------------------------------------------------
# Stage 1 — build: install all workspace deps and produce packages/web/dist.
# Based on oven/bun (for `bun install`); Node is copied in from node:22-slim to
# drive the Vite build.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.9 AS build

# Pull in a Node runtime (+ npm) for the Vite build step.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Copy the whole repo, then install. (Manifests-only install before the source
# copy is the usual cache trick, but vite-plugin-solid resolves solid-refresh's
# babel module through the workspace tree at build time, so we install against
# the full checkout to keep that resolution intact.)
COPY . .
RUN bun install --frozen-lockfile

# Build the web bundle with Node-driven Vite (vite → packages/web/dist). Run
# from the web package so Vite picks up packages/web/vite.config.ts. Equivalent
# to `bun run build` but uses Node to dodge the baseline-Bun resolver bug above.
RUN cd packages/web && node node_modules/vite/bin/vite.js build

# ---------------------------------------------------------------------------
# Stage 2 — runtime: a slim image with only what's needed to run the server +
# serve the built client. Runs as the non-root `bun` user shipped in the image.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.9-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    MEDIA_DIR=/data/media

# Copy only what's needed to run the server + serve the built client. The server
# resolves web/dist relative to its own source dir (import.meta.dir/../../web/
# dist), so the packages/ layout is preserved. Root node_modules holds the Bun
# content store (.bun/) that all workspace symlinks point into.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# The server workspace's node_modules holds the symlinks (hono, drizzle-orm, …)
# into the root .bun store — without it the server can't resolve its deps.
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/server/src ./packages/server/src
# The shared package (source + its own node_modules symlinks).
COPY --from=build /app/packages/shared ./packages/shared
# Only the built web client is needed at runtime — not its source or deps.
COPY --from=build /app/packages/web/dist ./packages/web/dist

# /data is the persistent volume root (SQLite db + media). Create it owned by
# the non-root `bun` user so first-boot writes succeed.
RUN mkdir -p /data && chown -R bun:bun /app /data
VOLUME ["/data"]

# Drop privileges: the official oven/bun image ships a `bun` user.
USER bun

EXPOSE 3000

# Liveness: hit the API health probe. Uses Bun's fetch (no curl in the slim
# image). Exits non-zero on any failure so Docker marks the container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# One process: the server, serving API + static client on $PORT.
CMD ["bun", "run", "packages/server/src/index.ts"]
