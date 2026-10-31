#!/usr/bin/env bash
# Deletes the droplet's database (and photos) for a clean start, then restarts
# the app, which creates an empty database. No copy is kept; the hourly backups
# are not touched.
#
#   usage: deploy/wipe-db.sh [user@droplet-ip] [--keep-photos] [--yes]
#
#   Gone:  sessions, chat history, claims, points, rewards, secrets progress,
#          and the admin settings (global persona, secrets switch, chat pause).
#   Kept:  people, personas and gates (files in their own folders).
#   --keep-photos  leaves the photos folder alone.
#   --yes          skips the "type wipe" question.
#
# The target can also come from DEPLOY_HOST in ~/.config/ipsengpt/deploy.env.
set -euo pipefail

CONFIG=${DEPLOY_CONFIG:-$HOME/.config/ipsengpt/deploy.env}
# shellcheck disable=SC1090
[[ -f $CONFIG ]] && source "$CONFIG"

TARGET=${DEPLOY_HOST:-}
REMOTE_DIR=${REMOTE_DIR:-/srv/ipsengpt/app}
PHOTOS=1
ASK=1
for arg in "$@"; do
  case $arg in
    --keep-photos) PHOTOS=0 ;;
    --yes) ASK=0 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) TARGET=$arg ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
# shellcheck disable=SC2029
remote() { ssh "$TARGET" "$@"; }

[[ -n $TARGET ]] || die "no target: deploy/wipe-db.sh user@droplet-ip"

DATA_ROOT=$(remote "grep -oP '^DATA_ROOT=\K.*' $REMOTE_DIR/.env || true")
DATA_ROOT=${DATA_ROOT:-/srv/ipsengpt}
what="the database"
((PHOTOS)) && what="the database and all photos"

if ((ASK)); then
  printf 'This deletes %s on %s (%s). No copy is kept.\nType "wipe" to go on: ' "$what" "$TARGET" "$DATA_ROOT"
  read -r answer
  [[ $answer == wipe ]] || die "not wiped"
fi

log "stop: app"
remote "cd $REMOTE_DIR && docker compose stop app >/dev/null 2>&1"

log "wipe: $what"
# The -wal and -shm files go too, or SQLite would replay old data into the new database.
remote "set -e
  sudo -n rm -f $DATA_ROOT/db/ipsengpt.sqlite $DATA_ROOT/db/ipsengpt.sqlite-wal $DATA_ROOT/db/ipsengpt.sqlite-shm
  if [ $PHOTOS = 1 ]; then sudo -n find $DATA_ROOT/photos -mindepth 1 -delete; fi"

log "start: app (creates an empty database)"
remote "cd $REMOTE_DIR && set -a && . ./.env && set +a
  docker compose start app >/dev/null 2>&1
  for _ in \$(seq 1 60); do
    curl -sf http://127.0.0.1:\${APP_PORT:-3000}/api/health >/dev/null && exit 0
    sleep 1
  done
  docker compose logs --tail 50 app; exit 1" || die "app did not come back healthy"
log "wiped. Set the global persona and the secrets switch again in admin."
