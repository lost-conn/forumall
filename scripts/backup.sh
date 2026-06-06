#!/usr/bin/env bash
#
# Forumall backup — snapshot a provider's entire state into a single tarball.
#
# A Forumall provider's whole state is two things under DATA_DIR:
#   1. the SQLite database file (forumall.sqlite)  — users, groups, messages, …
#   2. the media/ directory                         — uploaded attachments
# There is no other state (the provider signing key lives inside the DB). Back up
# those two and you can restore the provider anywhere.
#
# The DB runs in WAL mode, so it is unsafe to just `cp` the file while the server
# is running (you'd miss data sitting in the -wal file, or capture a torn page).
# This script instead asks SQLite for a *consistent hot copy* via `VACUUM INTO`,
# which is safe to run against a live database, then archives that copy together
# with the media dir. The server can stay up the whole time.
#
# Usage:
#   scripts/backup.sh [DATA_DIR] [OUT_DIR]
#
#   DATA_DIR  directory holding forumall.sqlite + media/  (default: ./data,
#             or $DATA_DIR if set).
#   OUT_DIR   where to write the backup tarball           (default: ./backups).
#
# Docker (named volume) usage — run a throwaway container that mounts the volume
# and this scripts dir, then invoke the script with DATA_DIR=/data:
#
#   docker compose run --rm --no-deps \
#     -v "$PWD/scripts:/scripts" -v "$PWD/backups:/backups" \
#     app bash /scripts/backup.sh /data /backups
#
# Output: $OUT_DIR/forumall-backup-YYYYmmdd-HHMMSS.tar.gz
set -euo pipefail

DATA_DIR="${1:-${DATA_DIR:-./data}}"
OUT_DIR="${2:-./backups}"

DB_PATH="${DB_PATH:-$DATA_DIR/forumall.sqlite}"
MEDIA_DIR="${MEDIA_DIR:-$DATA_DIR/media}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "backup: no database at '$DB_PATH' (is DATA_DIR correct?)" >&2
  exit 1
fi

# Pick a sqlite CLI: prefer the system `sqlite3`, else fall back to Bun's bundled
# SQLite via `bun:sqlite` so the script works inside the app image (no sqlite3).
hot_copy() {
  local src="$1" dest="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$src" "VACUUM INTO '$dest';"
  elif command -v bun >/dev/null 2>&1; then
    bun --eval "
      const { Database } = require('bun:sqlite');
      const db = new Database(process.argv[1], { readonly: true });
      db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
      db.close();
    " "$src" "$dest"
  else
    echo "backup: need either 'sqlite3' or 'bun' on PATH to make a consistent copy" >&2
    exit 1
  fi
}

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "backup: snapshotting database (consistent hot copy via VACUUM INTO)…"
hot_copy "$DB_PATH" "$STAGE/forumall.sqlite"

if [[ -d "$MEDIA_DIR" ]]; then
  echo "backup: copying media…"
  cp -a "$MEDIA_DIR" "$STAGE/media"
else
  echo "backup: no media dir at '$MEDIA_DIR' (none uploaded yet) — skipping"
  mkdir -p "$STAGE/media"
fi

ARCHIVE="$OUT_DIR/forumall-backup-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" forumall.sqlite media

echo "backup: wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
