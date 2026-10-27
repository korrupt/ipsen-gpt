#!/usr/bin/env bash
# Runs deploy/deploy.sh for real, with a fake `ssh` that executes the "remote"
# side on this machine (docker load, rsync, compose up) in a temp directory.
source "$(dirname "$0")/lib.sh"

WORK=$(mktemp -d)
APP_PORT=$(free_port)
PRIMARY_PORT=$(free_port)
PROJECT=ipsengpt-deploytest-$$
PIDS=()
cleanup() {
  (cd "$WORK/app" 2>/dev/null && docker compose down -v >/dev/null 2>&1) || true
  # Images built by deploy.sh during this test.
  docker images --format '{{.Repository}}:{{.Tag}}' | grep -x "ipsengpt:$(git -C "$REPO_ROOT" rev-parse --short HEAD).*" \
    | xargs -r docker rmi >/dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/bin" "$WORK/app/content" "$WORK/data"/{db,people,photos}
# Fake ssh: drop options and the host, run the command locally.
cat > "$WORK/bin/ssh" <<'SH'
#!/usr/bin/env bash
while [[ $# -gt 0 && $1 == -* ]]; do case $1 in -[lpioeF]) shift 2 ;; *) shift ;; esac; done
shift # host
exec bash -c "$*"
SH
chmod +x "$WORK/bin/ssh"

MOCK_OLLAMA_PORT=$PRIMARY_PORT MOCK_OLLAMA_REPLY=PRIMARY-REPLY \
  "$REPO_ROOT/apps/server/node_modules/.bin/tsx" "$REPO_ROOT/apps/server/src/dev/mock-ollama-cli.ts" >/dev/null 2>&1 &
PIDS+=($!)
wait_for 15 curl -sf "http://127.0.0.1:$PRIMARY_PORT/api/version" || fail "mock did not start"

cat > "$WORK/app/.env" <<ENV
COMPOSE_PROJECT_NAME=$PROJECT
IPSENGPT_TAG=previous-tag
APP_PORT=$APP_PORT
DATA_ROOT=$WORK/data
OLLAMA_URL=http://127.0.0.1:$PRIMARY_PORT
OLLAMA_MODEL=mock
ADMIN_PASSWORD=deploy-test-pw
ENV

step "deploy.sh to a fake droplet"
deploy() { PATH="$WORK/bin:$PATH" REMOTE_DIR="$WORK/app" DEPLOY_CONFIG=/nonexistent "$DEPLOY_DIR/deploy.sh" fake-droplet --skip-checks; }
out=$(deploy 2>&1) || fail "deploy failed: $out"
pass "deploy.sh exits 0"
tag=$(grep -oP '^IPSENGPT_TAG=\K.*' "$WORK/app/.env")
assert_contains "$tag" "$(git -C "$REPO_ROOT" rev-parse --short HEAD)" "IPSENGPT_TAG updated to the git revision"
assert_contains "$out" "previous: previous-tag" "reports the previous tag for rollback"
cmp -s "$DEPLOY_DIR/docker-compose.yml" "$WORK/app/docker-compose.yml" && pass "compose file synced" || fail "compose not synced"
cmp -s "$REPO_ROOT/content/persona.md" "$WORK/app/content/persona.md" && pass "persona synced" || fail "persona not synced"
cmp -s "$REPO_ROOT/content/gates.json" "$WORK/app/content/gates.json" && pass "gates synced" || fail "gates not synced"
docker image inspect "ipsengpt:$tag" >/dev/null && pass "image loaded via docker save | ssh docker load"

BASE="http://127.0.0.1:$APP_PORT"
token=$(curl -sf -X POST "$BASE/api/session" -H 'content-type: application/json' -d '{"name":"Kari"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
assert_contains "$(curl -sN -X POST "$BASE/api/chat" -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"message":"hi"}')" \
  "PRIMARY-REPLY" "deployed app chats through the PC"

step "Redeploy keeps data"
out=$(deploy 2>&1) || fail "second deploy failed: $out"
assert_contains "$(curl -sf "$BASE/api/session" -H "authorization: Bearer $token")" '"name":"Kari"' "session survives redeploy"

step "Refuses to deploy without a .env on the droplet"
mv "$WORK/app/.env" "$WORK/app/.env.bak"
out=$(deploy 2>&1) && fail "deployed without .env" || assert_contains "$out" ".env missing" "clear error without .env"
mv "$WORK/app/.env.bak" "$WORK/app/.env"

printf '\n\033[32m%d checks passed\033[0m\n' "$PASS"
