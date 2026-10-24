#!/usr/bin/env bash
# Keeps a reverse SSH tunnel open so the droplet can reach this PC's Ollama:
#   droplet 127.0.0.1:11435  ──ssh──▶  this PC 127.0.0.1:11434
# Reconnects forever. Run it in a terminal that stays open all night (on
# Windows this also keeps WSL alive).
#
# Settings (env vars, or ~/.config/ipsengpt/tunnel.env):
#   TUNNEL_HOST   droplet IP or a DNS-only name. NOT artifical.ipsen.no: that
#                 name goes through Cloudflare's proxy, which doesn't carry SSH.
#   TUNNEL_KEY    private key (default ~/.ssh/ipsengpt_tunnel)
#   TUNNEL_PORT   ssh port (default 22)
#   LOCAL_OLLAMA  where Ollama listens here (default 127.0.0.1:11434)
set -uo pipefail

CONFIG=${TUNNEL_CONFIG:-$HOME/.config/ipsengpt/tunnel.env}
# shellcheck disable=SC1090
[[ -f $CONFIG ]] && source "$CONFIG"

TUNNEL_HOST=${TUNNEL_HOST:-}
TUNNEL_USER=${TUNNEL_USER:-tunnel}
TUNNEL_KEY=${TUNNEL_KEY:-$HOME/.ssh/ipsengpt_tunnel}
TUNNEL_PORT=${TUNNEL_PORT:-22}
LOCAL_OLLAMA=${LOCAL_OLLAMA:-127.0.0.1:11434}
REMOTE_LISTEN=127.0.0.1:11435
RETRY_SECONDS=${RETRY_SECONDS:-5}
# Extra ssh options, e.g. for tests. Word-split on purpose.
TUNNEL_SSH_OPTS=${TUNNEL_SSH_OPTS:-}

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

[[ -n $TUNNEL_HOST ]] || { echo "Set TUNNEL_HOST (droplet IP) in the environment or $CONFIG" >&2; exit 2; }
[[ -r $TUNNEL_KEY ]] || { echo "Key $TUNNEL_KEY not found. Create it: ssh-keygen -t ed25519 -N '' -f $TUNNEL_KEY" >&2; exit 2; }

trap 'log "stopped"; exit 0' INT TERM

if curl -sf --max-time 3 "http://$LOCAL_OLLAMA/api/version" >/dev/null; then
  log "local Ollama is up at $LOCAL_OLLAMA"
else
  log "WARNING: no Ollama at $LOCAL_OLLAMA yet (guests get the fallback model until it's up)"
fi

while true; do
  log "connecting to $TUNNEL_USER@$TUNNEL_HOST: droplet $REMOTE_LISTEN -> $LOCAL_OLLAMA"
  # shellcheck disable=SC2086
  ssh -N \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new \
    $TUNNEL_SSH_OPTS \
    -i "$TUNNEL_KEY" -p "$TUNNEL_PORT" \
    -R "$REMOTE_LISTEN:$LOCAL_OLLAMA" \
    "$TUNNEL_USER@$TUNNEL_HOST"
  log "tunnel closed (ssh exit $?), reconnecting in ${RETRY_SECONDS}s"
  sleep "$RETRY_SECONDS"
done
