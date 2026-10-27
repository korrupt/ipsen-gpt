#!/usr/bin/env bash
# One-time (re-runnable) droplet setup. Run as root on a fresh Ubuntu droplet:
#
#   scp -r deploy/droplet root@<droplet-ip>:/root/ipsengpt-setup
#   ssh root@<droplet-ip> /root/ipsengpt-setup/setup.sh \
#       --admin-user <name> --tunnel-key "<contents of ~/.ssh/ipsengpt_tunnel.pub>" \
#       --email <you@example.com>
#
# --domain <name> serves another hostname (default chat.ipsen.no).
# Steps can be skipped with --skip <step> (repeatable):
#   swap admin tunnel sshd firewall packages docker dirs cert nginx backup
set -euo pipefail
source "$(dirname "$0")/lib.sh"

DOMAIN=chat.ipsen.no
ADMIN_USER=''
TUNNEL_KEY=''
EMAIL=''
SKIP=()

usage() { sed -n '2,11p' "$0"; exit "${1:-0}"; }
while [[ $# -gt 0 ]]; do
  case $1 in
    --admin-user) ADMIN_USER=$2; shift 2 ;;
    --tunnel-key) TUNNEL_KEY=$2; shift 2 ;;
    --email) EMAIL=$2; shift 2 ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --skip) SKIP+=("$2"); shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done
skip() { [[ " ${SKIP[*]} " == *" $1 "* ]]; }

require_root
[[ -n $ADMIN_USER ]] || skip admin || die "--admin-user is required"
[[ -n $TUNNEL_KEY ]] || skip tunnel || die "--tunnel-key is required"
[[ -n $EMAIL ]] || skip cert || die "--email is required (Let's Encrypt account)"

skip swap     || setup_swap 2G
skip packages || install_packages
skip admin    || setup_admin_user "$ADMIN_USER"
skip tunnel   || setup_tunnel_user "$TUNNEL_KEY"
skip sshd     || install_sshd_config
skip firewall || setup_firewall
skip docker   || install_docker
skip dirs     || setup_dirs "$ADMIN_USER"
skip cert     || issue_certificate "$DOMAIN" "$EMAIL"
skip nginx    || install_nginx_site "$DOMAIN"
skip backup   || install_backup_cron

log "done. Next: on your PC run deploy/deploy.sh (see README, 'Deploy')."
