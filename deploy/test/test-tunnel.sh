#!/usr/bin/env bash
# Provisions an Ubuntu container with the droplet's tunnel user + sshd config
# (same lib.sh functions as setup.sh), then runs deploy/pc/tunnel.sh against it.
source "$(dirname "$0")/lib.sh"

IMAGE=ipsengpt-sshd-test
WORK=$(mktemp -d)
NAME=ipsengpt-sshd-test-$$
SSH_PORT=$(free_port)
OLLAMA_PORT=$(free_port)
PIDS=()
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

step "Provision an Ubuntu 24.04 'droplet' container"
docker build -q -t "$IMAGE" - >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server curl iproute2 procps >/dev/null \
 && ssh-keygen -A && mkdir -p /run/sshd \
 && printf 'PasswordAuthentication yes\nKbdInteractiveAuthentication yes\n' > /etc/ssh/sshd_config.d/50-cloud-init.conf
DOCKERFILE
# (50-cloud-init.conf mimics cloud images that enable passwords; ours must win.)
ssh-keygen -q -t ed25519 -N '' -f "$WORK/tunnel_key" -C ipsengpt-tunnel
ssh-keygen -q -t ed25519 -N '' -f "$WORK/other_key"
docker run -d --name "$NAME" -p "127.0.0.1:$SSH_PORT:22" -v "$DEPLOY_DIR/droplet:/setup:ro" "$IMAGE" \
  bash -c "source /setup/lib.sh && setup_tunnel_user '$(cat "$WORK/tunnel_key.pub")' && install_sshd_config && exec /usr/sbin/sshd -D -e" >/dev/null
wait_for 20 bash -c "ssh-keyscan -p $SSH_PORT 127.0.0.1 2>/dev/null | grep -q ed25519" || { docker logs "$NAME"; fail "sshd did not start"; }
pass "lib.sh provisioned the tunnel user and sshd config; sshd -t passed"
assert_contains "$(docker exec "$NAME" cat /home/tunnel/.ssh/authorized_keys)" \
  'restrict,port-forwarding,permitlisten="127.0.0.1:11435" ssh-ed25519' "authorized_keys line is restricted"
assert_eq "$(docker exec "$NAME" getent passwd tunnel | cut -d: -f7)" "/usr/sbin/nologin" "tunnel user has no shell"

SSH=(ssh -p "$SSH_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no
     -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)

step "The tunnel key can do nothing but listen on 127.0.0.1:11435"
out=$(timeout 10 "${SSH[@]}" -i "$WORK/tunnel_key" tunnel@127.0.0.1 id 2>&1 || true)
assert_not_contains "$out" "uid=" "cannot run commands"
# An accepted -N forward keeps ssh running until `timeout` kills it (exit 124);
# a refused one makes ssh exit by itself (ExitOnForwardFailure).
forward_exit() { # -R spec
  local code=0
  timeout 6 "${SSH[@]}" -i "$WORK/tunnel_key" -N -o ExitOnForwardFailure=yes -R "$1" tunnel@127.0.0.1 >/dev/null 2>&1 || code=$?
  echo "$code"
}
[[ $(forward_exit 127.0.0.1:11435:127.0.0.1:1) == 124 ]] && pass "may listen on 127.0.0.1:11435 (control)" \
  || fail "the allowed forward was refused"
[[ $(forward_exit 127.0.0.1:9999:127.0.0.1:1) != 124 ]] && pass "cannot listen on another port" \
  || fail "listening on another port was allowed"
[[ $(forward_exit 0.0.0.0:11435:127.0.0.1:1) != 124 ]] && pass "cannot listen on a public address" \
  || fail "listening on 0.0.0.0 was allowed"
LPORT=$(free_port)
"${SSH[@]}" -i "$WORK/tunnel_key" -N -L "$LPORT:127.0.0.1:22" tunnel@127.0.0.1 >/dev/null 2>&1 & PIDS+=($!)
sleep 2
banner=$(timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$LPORT; head -c 7 <&3" 2>/dev/null || true)
assert_not_contains "$banner" "SSH-" "cannot open local forwards into the droplet"
out=$(timeout 10 "${SSH[@]}" -i "$WORK/other_key" tunnel@127.0.0.1 true 2>&1 || true)
assert_contains "$out" "Permission denied" "other keys are rejected"
out=$(timeout 10 ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes \
  -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive root@127.0.0.1 true 2>&1 || true)
assert_contains "$out" "Permission denied (publickey)" "password login is off, despite 50-cloud-init.conf"

step "tunnel.sh brings the PC's Ollama to the droplet's 127.0.0.1:11435"
MOCK_OLLAMA_PORT=$OLLAMA_PORT MOCK_OLLAMA_REPLY=TUNNEL-OK \
  "$REPO_ROOT/apps/server/node_modules/.bin/tsx" "$REPO_ROOT/apps/server/src/dev/mock-ollama-cli.ts" >/dev/null 2>&1 & MOCK_PID=$!; PIDS+=("$MOCK_PID")
wait_for 15 curl -sf "http://127.0.0.1:$OLLAMA_PORT/api/version" || fail "mock ollama did not start"
TUNNEL_HOST=127.0.0.1 TUNNEL_PORT=$SSH_PORT TUNNEL_KEY="$WORK/tunnel_key" LOCAL_OLLAMA="127.0.0.1:$OLLAMA_PORT" \
  RETRY_SECONDS=1 TUNNEL_CONFIG=/nonexistent TUNNEL_SSH_OPTS="-o UserKnownHostsFile=$WORK/known_hosts" \
  "$DEPLOY_DIR/pc/tunnel.sh" > "$WORK/tunnel.log" 2>&1 & PIDS+=($!)
remote_curl() { docker exec "$NAME" curl -sf --max-time 3 "$@"; }
wait_for 20 remote_curl http://127.0.0.1:11435/api/version || { cat "$WORK/tunnel.log"; fail "tunnel not up"; }
assert_contains "$(remote_curl http://127.0.0.1:11435/api/version)" "mock" "droplet reaches the PC's Ollama through the tunnel"
reply=$(docker exec "$NAME" curl -sN --max-time 5 http://127.0.0.1:11435/api/chat -d '{"model":"m","messages":[]}')
assert_contains "$reply" "TUNNEL-OK" "streaming chat works through the tunnel"
assert_eq "$(docker exec "$NAME" ss -ltnH 'sport = :11435' | awk '{print $4}' | sort -u | tr '\n' ' ')" "127.0.0.1:11435 " \
  "forward listens on the droplet's loopback only"

step "Resilience"
docker exec "$NAME" pkill -f 'sshd: tunnel' || true
sleep 1
wait_for 20 remote_curl http://127.0.0.1:11435/api/version && pass "tunnel.sh reconnects after the connection drops" \
  || { cat "$WORK/tunnel.log"; fail "no reconnect"; }
kill "$MOCK_PID"
t0=$(date +%s%N)
remote_curl http://127.0.0.1:11435/api/version >/dev/null 2>&1 && fail "still reachable with Ollama down" || true
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
(( ms < 2500 )) && pass "with Ollama down on the PC, the droplet fails fast (${ms} ms) -> app closes chat" \
  || fail "slow failure when Ollama is down (${ms} ms)"

printf '\n\033[32m%d checks passed\033[0m\n' "$PASS"
