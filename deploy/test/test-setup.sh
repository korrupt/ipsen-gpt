#!/usr/bin/env bash
# Runs the real droplet/setup.sh (twice, for idempotency) in Ubuntu 24.04.
# Skips what a container can't do: swap, ufw, the Docker install and the real
# certificate (a dummy cert stands in so the Nginx site can be installed).
source "$(dirname "$0")/lib.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ssh-keygen -q -t ed25519 -N '' -f "$WORK/tunnel_key"
PUB=$(cat "$WORK/tunnel_key.pub")

step "setup.sh on Ubuntu 24.04"
out=$(docker run --rm -v "$DEPLOY_DIR/droplet:/setup:ro" -e PUB="$PUB" ubuntu:24.04 bash -euo pipefail -c '
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server sudo curl openssl >/dev/null
  ssh-keygen -A >/dev/null
  mkdir -p /root/.ssh && echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVyYWRtaW5rZXlleGFtcGxlZm9ydGVzdGluZ3h4 admin" > /root/.ssh/authorized_keys
  mkdir -p /etc/letsencrypt/live/artifical.ipsen.no
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=x -keyout /etc/letsencrypt/live/artifical.ipsen.no/privkey.pem \
    -out /etc/letsencrypt/live/artifical.ipsen.no/fullchain.pem 2>/dev/null
  cp -r /setup /root/ipsengpt-setup
  run() { /root/ipsengpt-setup/setup.sh --admin-user ghost --tunnel-key "$PUB" --email t@example.com \
      --skip swap --skip firewall --skip docker --skip cert; }

  if /root/ipsengpt-setup/setup.sh --admin-user ghost --skip cert >/dev/null 2>&1; then echo "missing_args=accepted"; else echo "missing_args=rejected"; fi
  run > /tmp/run1.log 2>&1 || { cat /tmp/run1.log; exit 1; }
  run > /tmp/run2.log 2>&1 || { echo "second run failed"; cat /tmp/run2.log; exit 1; }
  echo "rerun=ok"

  echo "admin_groups=$(id -nG ghost)"
  echo "admin_key=$(stat -c "%a %U" /home/ghost/.ssh/authorized_keys)"
  sudo -u ghost sudo -n true && echo "admin_sudo=ok"
  echo "tunnel_shell=$(getent passwd tunnel | cut -d: -f7)"
  echo "tunnel_keys=$(grep -c . /home/tunnel/.ssh/authorized_keys)"
  sshd -t && echo "sshd_t=ok"
  sshd -T -C user=tunnel,host=x,addr=1.2.3.4 | grep -iE "^(permitlisten|allowtcpforwarding|passwordauthentication|gatewayports) " | tr "\n" ";"; echo
  echo "dirs=$(stat -c "%n:%u:%a" /srv/ipsengpt/db /srv/ipsengpt/people /srv/ipsengpt/photos | tr "\n" " ")"
  echo "appdir_owner=$(stat -c %U /srv/ipsengpt/app)"
  echo "site=$(readlink /etc/nginx/sites-enabled/ipsengpt) default=$([[ -e /etc/nginx/sites-enabled/default ]] && echo present || echo removed)"
  nginx -t 2>/dev/null && echo "nginx_t=ok"
  echo "realip=$(grep -c set_real_ip_from /etc/nginx/conf.d/cloudflare-realip.conf)"
  echo "cron=$(grep -c ipsengpt-backup /etc/cron.d/ipsengpt-backup) backup_bin=$([[ -x /usr/local/bin/ipsengpt-backup ]] && echo yes)"
  command -v sqlite3 rsync certbot >/dev/null && echo "packages=ok"
' 2>&1) || fail "setup run failed: $out"

assert_contains "$out" "missing_args=rejected" "refuses to run without required options"
assert_contains "$out" "rerun=ok" "runs twice without errors (idempotent)"
assert_contains "$out" "sudo" "admin user is in the sudo group"
assert_contains "$out" "admin_key=600 ghost" "admin user got root's SSH keys"
assert_contains "$out" "admin_sudo=ok" "admin user has passwordless sudo"
assert_contains "$out" "tunnel_shell=/usr/sbin/nologin" "tunnel user has no shell"
assert_contains "$out" "tunnel_keys=1" "re-running doesn't duplicate the tunnel key"
assert_contains "$out" "sshd_t=ok" "sshd config valid"
assert_contains "$out" "permitlisten 127.0.0.1:11435" "effective sshd config for tunnel: PermitListen"
assert_contains "$out" "allowtcpforwarding remote" "effective sshd config for tunnel: remote forwarding only"
assert_contains "$out" "passwordauthentication no" "effective sshd config: no passwords"
assert_contains "$out" "gatewayports no" "effective sshd config: GatewayPorts no"
assert_contains "$out" "/srv/ipsengpt/db:1000:750 /srv/ipsengpt/people:1000:750 /srv/ipsengpt/photos:1000:750" \
  "data dirs owned by the container's node user"
assert_contains "$out" "appdir_owner=ghost" "admin user owns the app dir (for deploys)"
assert_contains "$out" "site=/etc/nginx/sites-available/ipsengpt default=removed" "nginx site enabled, default removed"
assert_contains "$out" "nginx_t=ok" "installed nginx config passes nginx -t"
assert_contains "$out" "cron=1 backup_bin=yes" "hourly backup cron installed"
assert_contains "$out" "packages=ok" "sqlite3, rsync, certbot installed"

printf '\n\033[32m%d checks passed\033[0m\n' "$PASS"
