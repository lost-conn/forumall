#!/usr/bin/env bash
#
# Forumall restore — restore a provider's state from a backup.sh tarball.
#
# Restores both the SQLite database and the media/ directory into DATA_DIR,
# replacing whatever is there. The schema is forward-only and migrations run on
# every boot, so a backup taken on an older version restores cleanly onto a newer
# image: just restore, then start the server and it migrates the DB up.
#
# IMPORTANT: stop the server before restoring (you are overwriting its live DB).
# For the Docker stack:  docker compose stop app   (restore)   docker compose start app
#
# Usage:
#   scripts/restore.sh BACKUP.tar.gz [DATA_DIR]
#
#   BACKUP    path to a forumall-backup-*.tar.gz produced by backup.sh.
#   DATA_DIR  directory to restore into  (default: ./data, or $DATA_DIR if set).
#
# Docker (named volume) usage:
#   docker compose stop app
#   docker compose run --rm --no-deps \
#     -v "$PWD/scripts:/scripts" -v "$PWD/backups:/backups" \
#     app bash /scripts/restore.sh /backups/forumall-backup-XXXX.tar.gz /data
#   docker compose start app
set -euo pipefail

BACKUP="${1:?usage: restore.sh BACKUP.tar.gz [DATA_DIR]}"
DATA_DIR="${2:-${DATA_DIR:-./data}}"

DB_PATH="${DB_PATH:-$DATA_DIR/forumall.sqlite}"
MEDIA_DIR="${MEDIA_DIR:-$DATA_DIR/media}"

if [[ ! -f "$BACKUP" ]]; then
  echo "restore: backup file '$BACKUP' not found" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "restore: extracting $BACKUP…"
tar -xzf "$BACKUP" -C "$STAGE"

if [[ ! -f "$STAGE/forumall.sqlite" ]]; then
  echo "restore: archive has no forumall.sqlite — not a Forumall backup?" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

# Replace the DB. Remove any stale WAL/SHM sidecar files first so they can't be
# applied on top of the freshly-restored (already-checkpointed) database.
echo "restore: writing database to $DB_PATH…"
rm -f "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"
cp "$STAGE/forumall.sqlite" "$DB_PATH"

# Replace media wholesale.
echo "restore: writing media to $MEDIA_DIR…"
rm -rf "$MEDIA_DIR"
if [[ -d "$STAGE/media" ]]; then
  cp -a "$STAGE/media" "$MEDIA_DIR"
else
  mkdir -p "$MEDIA_DIR"
fi

echo "restore: done. Start the server — migrations run automatically on boot."
