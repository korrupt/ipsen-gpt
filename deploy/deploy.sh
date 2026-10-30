#!/usr/bin/env bash
# Builds the image on this machine (the droplet only has 4 GB RAM), ships it
# over SSH (no registry needed), syncs compose + gates, and restarts the app.
# Personas are edited in admin and live in the data folder; deploys never touch them.
#
#   usage: deploy/deploy.sh [user@droplet-ip] [--skip-checks]
#
# The target can also come from DEPLOY_HOST in ~/.config/ipsengpt/deploy.env.
# First time: run droplet/setup.sh, then create /srv/ipsengpt/app/.env from
# deploy/env.production.example (deploy.sh never overwrites it).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG=${DEPLOY_CONFIG:-$HOME/.config/ipsengpt/deploy.env}
# shellcheck disable=SC1090
[[ -f $CONFIG ]] && source "$CONFIG"

TARGET=${DEPLOY_HOST:-}
REMOTE_DIR=${REMOTE_DIR:-/srv/ipsengpt/app}
RUN_CHECKS=1
for arg in "$@"; do
  case $arg in
    --skip-checks) RUN_CHECKS=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) TARGET=$arg ;;
  esac
done

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
# Local variables in remote commands are expanded here on purpose.
# shellcheck disable=SC2029
remote() { ssh "$TARGET" "$@"; }

[[ -n $TARGET ]] || die "no target: deploy/deploy.sh user@droplet-ip (the droplet IP, not the Cloudflare name)"
cd "$REPO_ROOT"

TAG=$(git rev-parse --short HEAD)
git diff --quiet HEAD || TAG="$TAG-dirty-$(date +%H%M%S)"

if ((RUN_CHECKS)); then
  log "checks: pnpm check"
  pnpm check >/dev/null || die "pnpm check failed (use --skip-checks to deploy anyway)"
fi

remote "test -f $REMOTE_DIR/.env" \
  || die "$TARGET:$REMOTE_DIR/.env missing. Create it from deploy/env.production.example first."

log "build: ipsengpt:$TAG (linux/amd64)"
docker build --platform linux/amd64 -q -t "ipsengpt:$TAG" . >/dev/null

log "ship: image -> $TARGET"
docker save "ipsengpt:$TAG" | gzip -1 | remote 'gunzip | docker load' >/dev/null

log "sync: compose file and gates"
rsync -a deploy/docker-compose.yml "$TARGET:$REMOTE_DIR/docker-compose.yml"
rsync -a content/gates.json "$TARGET:$REMOTE_DIR/content/"

PREVIOUS=$(remote "grep -oP '^IPSENGPT_TAG=\K.*' $REMOTE_DIR/.env || true")
log "start: $PREVIOUS -> $TAG"
remote "set -e
  cd $REMOTE_DIR
  sed -i 's/^IPSENGPT_TAG=.*/IPSENGPT_TAG=$TAG/' .env
  grep -q '^IPSENGPT_TAG=' .env || echo 'IPSENGPT_TAG=$TAG' >> .env
  set -a; . ./.env; set +a
  # Data folders added after setup.sh ran: created for the container's node user (uid 1000),
  # or Docker would create them as root and the app couldn't write.
  for dir in personas; do
    path=\${DATA_ROOT:-/srv/ipsengpt}/\$dir
    [ -d \"\$path\" ] || sudo -n install -d -m 750 -o 1000 -g 1000 \"\$path\"
  done
  docker compose up -d --remove-orphans >/dev/null 2>&1
  for _ in \$(seq 1 60); do
    curl -sf http://127.0.0.1:\${APP_PORT:-3000}/api/health >/dev/null && exit 0
    sleep 1
  done
  docker compose logs --tail 50 app
  exit 1" || die "app did not become healthy. Roll back: deploy/deploy.sh is idempotent; or on the droplet set IPSENGPT_TAG=$PREVIOUS in $REMOTE_DIR/.env and run 'docker compose up -d'"

log "deployed ipsengpt:$TAG (previous: ${PREVIOUS:-none})"
