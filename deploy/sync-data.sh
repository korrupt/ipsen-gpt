#!/usr/bin/env bash
# Copies party data written locally to the droplet's data folders, then restarts
# the app so it re-reads people (personas are re-read on every message).
#
#   usage: deploy/sync-data.sh [user@droplet-ip] [--personas] [--dry-run]
#
#   people      data/people/<slug>/ -> $DATA_ROOT/people/. Adds and overwrites
#               folders with the same slug; people only on the droplet are kept.
#   --personas  also replaces the droplet's personas with content/personas/:
#               personas not shipped any more go to personas/.trash/.
#   --dry-run   shows what rsync would change, changes nothing.
#
# The target can also come from DEPLOY_HOST in ~/.config/ipsengpt/deploy.env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG=${DEPLOY_CONFIG:-$HOME/.config/ipsengpt/deploy.env}
# shellcheck disable=SC1090
[[ -f $CONFIG ]] && source "$CONFIG"

TARGET=${DEPLOY_HOST:-}
REMOTE_DIR=${REMOTE_DIR:-/srv/ipsengpt/app}
PERSONAS=0
DRY=()
for arg in "$@"; do
  case $arg in
    --personas) PERSONAS=1 ;;
    --dry-run) DRY=(--dry-run --itemize-changes) ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) TARGET=$arg ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
# shellcheck disable=SC2029
remote() { ssh "$TARGET" "$@"; }

[[ -n $TARGET ]] || die "no target: deploy/sync-data.sh user@droplet-ip"
cd "$REPO_ROOT"
[[ -d data/people ]] || die "no data/people folder here"

DATA_ROOT=$(remote "grep -oP '^DATA_ROOT=\K.*' $REMOTE_DIR/.env || true")
DATA_ROOT=${DATA_ROOT:-/srv/ipsengpt}
STAGE=$(remote 'mktemp -d')
trap 'remote "rm -rf $STAGE"' EXIT

# Staged in a temp folder first: the data folders belong to the container's node
# user (uid 1000), so the final copy runs with sudo and keeps that owner.
log "people: data/people -> $TARGET:$DATA_ROOT/people"
rsync -a --exclude .trash data/people/ "$TARGET:$STAGE/people/"
remote "sudo -n rsync -a ${DRY[*]} --chown=1000:1000 $STAGE/people/ $DATA_ROOT/people/"

if ((PERSONAS)); then
  log "personas: content/personas -> $TARGET:$DATA_ROOT/personas (old ones to .trash/)"
  rsync -a content/personas/ "$TARGET:$STAGE/personas/"
  if ((${#DRY[@]})); then
    remote "sudo -n rsync -a ${DRY[*]} --delete --exclude .trash $STAGE/personas/ $DATA_ROOT/personas/"
  else
    remote "set -e
      dir=$DATA_ROOT/personas
      sudo -n install -d -m 750 -o 1000 -g 1000 \$dir/.trash
      for f in \$dir/*.md; do
        [ -e \"\$f\" ] || continue
        [ -e $STAGE/personas/\$(basename \"\$f\") ] || sudo -n mv \"\$f\" \"\$dir/.trash/\$(basename \"\$f\" .md)-\$(date +%s).md\"
      done
      sudo -n rsync -a --chown=1000:1000 $STAGE/personas/ \$dir/"
  fi
fi

((${#DRY[@]})) && { log "dry run: nothing changed"; exit 0; }

log "restart: app (re-reads people)"
remote "cd $REMOTE_DIR && set -a && . ./.env && set +a
  docker compose restart app >/dev/null 2>&1
  for _ in \$(seq 1 60); do
    curl -sf http://127.0.0.1:\${APP_PORT:-3000}/api/health >/dev/null && exit 0
    sleep 1
  done
  docker compose logs --tail 50 app; exit 1" || die "app did not come back healthy"
log "synced"
