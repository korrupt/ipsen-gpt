# Droplet provisioning steps, sourced by setup.sh (and by the tests).
# Every function is idempotent: safe to re-run.
# shellcheck shell=bash

APP_ROOT=${APP_ROOT:-/srv/ipsengpt}
APP_UID=1000 # the "node" user inside the app image
TUNNEL_USER=tunnel
TUNNEL_LISTEN=127.0.0.1:11435
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "run as root (sudo $0)"; }

# Reloads a systemd service; without systemd (e.g. in the test container) just says so.
reload_service() { # name...
  # /run/systemd/system exists iff systemd is init. (Not `is-system-running`: it fails when merely "degraded".)
  if [[ -d /run/systemd/system ]]; then
    local name
    # try-reload-or-restart: works for the socket-activated ssh.service on 24.04 even when inactive.
    for name in "$@"; do systemctl try-reload-or-restart "$name" 2>/dev/null && return 0; done
    die "could not reload $*"
  fi
  log "(no systemd: skipped reloading $1)"
}

setup_swap() { # size, e.g. 2G
  if swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
    log "swap: /swapfile already active"
    return
  fi
  log "swap: creating $1 /swapfile"
  fallocate -l "$1" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-ipsengpt-swap.conf
  sysctl -q -p /etc/sysctl.d/90-ipsengpt-swap.conf
}

setup_admin_user() { # name
  local user=$1
  if ! id "$user" >/dev/null 2>&1; then
    log "admin user: creating $user"
    adduser --disabled-password --gecos '' "$user" >/dev/null
  fi
  usermod -aG sudo "$user"
  # Key-only login, so allow sudo without a password.
  echo "$user ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$user"
  chmod 440 "/etc/sudoers.d/90-$user"
  visudo -cq -f "/etc/sudoers.d/90-$user" || die "bad sudoers file"
  if [[ -f /root/.ssh/authorized_keys ]]; then
    install -d -m 700 -o "$user" -g "$user" "/home/$user/.ssh"
    install -m 600 -o "$user" -g "$user" /root/.ssh/authorized_keys "/home/$user/.ssh/authorized_keys"
  fi
  log "admin user: $user can log in with root's SSH keys and sudo"
}

# Prints the authorized_keys line for the tunnel key.
tunnel_authorized_key() { # public key line
  local key=$1
  [[ $key =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+)\ [A-Za-z0-9+/=]+ ]] || die "not an SSH public key: ${key:0:40}..."
  printf 'restrict,port-forwarding,permitlisten="%s" %s\n' "$TUNNEL_LISTEN" "$key"
}

setup_tunnel_user() { # public key line
  local line
  line=$(tunnel_authorized_key "$1")
  if ! id "$TUNNEL_USER" >/dev/null 2>&1; then
    log "tunnel user: creating $TUNNEL_USER (no shell)"
    useradd --create-home --shell /usr/sbin/nologin "$TUNNEL_USER"
  fi
  # '*' = no password login possible, but not "locked" (which blocks keys when UsePAM=no).
  usermod -p '*' "$TUNNEL_USER"
  local home
  home=$(getent passwd "$TUNNEL_USER" | cut -d: -f6)
  install -d -m 700 -o "$TUNNEL_USER" -g "$TUNNEL_USER" "$home/.ssh"
  printf '%s\n' "$line" > "$home/.ssh/authorized_keys"
  chown "$TUNNEL_USER:$TUNNEL_USER" "$home/.ssh/authorized_keys"
  chmod 600 "$home/.ssh/authorized_keys"
  log "tunnel user: key installed, may only listen on $TUNNEL_LISTEN"
}

install_sshd_config() {
  install -m 644 "$SCRIPT_DIR/sshd/10-ipsengpt.conf" /etc/ssh/sshd_config.d/10-ipsengpt.conf
  mkdir -p /run/sshd
  sshd -t || die "sshd config invalid; not reloading (fix /etc/ssh/sshd_config.d/10-ipsengpt.conf)"
  reload_service ssh sshd
  log "sshd: passwords off, GatewayPorts no, tunnel user restricted"
}

setup_firewall() {
  apt-get install -y -qq ufw >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  log "firewall: only 22, 80, 443 open (Docker ports must still use 127.0.0.1:)"
}

install_packages() {
  log "packages: nginx, certbot (Cloudflare DNS), sqlite3, rsync"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    nginx certbot python3-certbot-dns-cloudflare sqlite3 rsync curl ca-certificates >/dev/null
}

install_docker() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    log "docker: already installed ($(docker --version))"
    return
  fi
  log "docker: installing from Docker's apt repository"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
}

setup_dirs() { # [admin user who deploys]
  install -d -m 755 "$APP_ROOT" "$APP_ROOT/app" "$APP_ROOT/app/content"
  install -d -m 750 -o "$APP_UID" -g "$APP_UID" "$APP_ROOT/db" "$APP_ROOT/people" "$APP_ROOT/photos"
  install -d -m 700 "$APP_ROOT/backups"
  if [[ -n ${1:-} ]]; then
    chown -R "$1:$1" "$APP_ROOT/app"
    usermod -aG docker "$1" 2>/dev/null || true
  fi
  log "dirs: data in $APP_ROOT/{db,people,photos}, backups in $APP_ROOT/backups"
}

install_nginx_site() {
  "$SCRIPT_DIR/cloudflare-realip.sh" /etc/nginx/conf.d/cloudflare-realip.conf
  install -m 644 "$SCRIPT_DIR/nginx/ipsengpt.conf" /etc/nginx/sites-available/ipsengpt
  ln -sf /etc/nginx/sites-available/ipsengpt /etc/nginx/sites-enabled/ipsengpt
  rm -f /etc/nginx/sites-enabled/default
  nginx -t || die "nginx config invalid"
  reload_service nginx
  log "nginx: site installed"
}

issue_certificate() { # domain email
  local domain=$1 email=$2 creds=/root/.secrets/cloudflare.ini
  if [[ -f /etc/letsencrypt/live/$domain/fullchain.pem ]]; then
    log "certificate: already issued for $domain (certbot.timer renews it)"
    return
  fi
  if [[ ! -f $creds ]]; then
    install -d -m 700 /root/.secrets
    echo "Cloudflare API token with Zone:DNS:Edit on the zone (input hidden):"
    local token
    read -rs token
    [[ -n $token ]] || die "no token given"
    printf 'dns_cloudflare_api_token = %s\n' "$token" > "$creds"
    chmod 600 "$creds"
  fi
  log "certificate: requesting $domain via Cloudflare DNS challenge"
  certbot certonly --non-interactive --agree-tos -m "$email" \
    --dns-cloudflare --dns-cloudflare-credentials "$creds" --dns-cloudflare-propagation-seconds 30 \
    -d "$domain" \
    --deploy-hook 'systemctl reload nginx'
}

install_backup_cron() {
  install -m 755 "$SCRIPT_DIR/backup.sh" /usr/local/bin/ipsengpt-backup
  cat > /etc/cron.d/ipsengpt-backup <<CRON
# Hourly backup of the IpsenGPT database, people and photos.
5 * * * * root APP_ROOT=$APP_ROOT /usr/local/bin/ipsengpt-backup >> /var/log/ipsengpt-backup.log 2>&1
CRON
  log "backups: hourly to $APP_ROOT/backups (log: /var/log/ipsengpt-backup.log)"
}
