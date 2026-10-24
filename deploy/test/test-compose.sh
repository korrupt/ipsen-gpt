#!/usr/bin/env bash
# Runs the production compose stack locally with mock Ollamas standing in for
# the PC (primary, via "tunnel" port) and the fallback container.
source "$(dirname "$0")/lib.sh"

IMAGE_TAG=${IMAGE_TAG:-compose-test}
WORK=$(mktemp -d)
APP_PORT=$(free_port)
PRIMARY_PORT=$(free_port)
FALLBACK_PORT=$(free_port)
PROJECT=ipsengpt-test-$$
PIDS=()

cleanup() {
  (cd "$WORK" && docker compose -p "$PROJECT" -f docker-compose.yml -f override.yml down -v >/dev/null 2>&1) || true
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  docker rmi "ipsengpt:$IMAGE_TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step "Build image ipsengpt:$IMAGE_TAG"
docker build -q -t "ipsengpt:$IMAGE_TAG" "$REPO_ROOT" >/dev/null && pass "image builds"

start_mock() { # port reply
  MOCK_OLLAMA_PORT=$1 MOCK_OLLAMA_REPLY=$2 MOCK_OLLAMA_DELAY_MS=5 \
    "$REPO_ROOT/apps/server/node_modules/.bin/tsx" "$REPO_ROOT/apps/server/src/dev/mock-ollama-cli.ts" >/dev/null 2>&1 &
  PIDS+=($!)
  wait_for 15 curl -sf "http://127.0.0.1:$1/api/version" || fail "mock on $1 did not start"
}
start_mock "$PRIMARY_PORT" "PRIMARY-REPLY"
start_mock "$FALLBACK_PORT" "FALLBACK-REPLY"
PRIMARY_PID=${PIDS[0]}

step "Start stack (data in $WORK/data)"
cp "$DEPLOY_DIR/docker-compose.yml" "$WORK/"
mkdir -p "$WORK/content" "$WORK/data"/{db,people,photos}
echo "You are TestGhost." > "$WORK/content/persona.md"
cat > "$WORK/.env" <<ENV
IPSENGPT_TAG=$IMAGE_TAG
APP_PORT=$APP_PORT
DATA_ROOT=$WORK/data
OLLAMA_URL=http://127.0.0.1:$PRIMARY_PORT
OLLAMA_FALLBACK_URL=http://127.0.0.1:$FALLBACK_PORT
OLLAMA_PRIMARY_RETRY_MS=0
ADMIN_PASSWORD=compose-test-pw
ENV
# The real ollama service is replaced by a mock; everything else is the production file.
cat > "$WORK/override.yml" <<'YML'
services:
  ollama:
    profiles: [disabled]
YML
cd "$WORK"
docker compose -p "$PROJECT" -f docker-compose.yml -f override.yml up -d >/dev/null 2>&1 || fail "compose up"
BASE="http://127.0.0.1:$APP_PORT"
wait_for 30 curl -sf "$BASE/api/health" || { docker compose -p "$PROJECT" logs app; fail "app not healthy"; }
pass "app healthy on 127.0.0.1:$APP_PORT"

listen=$(ss -ltnH "sport = :$APP_PORT" | awk '{print $4}')
assert_eq "$listen" "127.0.0.1:$APP_PORT" "app listens on loopback only"
assert_contains "$(curl -s "$BASE/")" "<title>IpsenGPT</title>" "serves the guest app"
assert_contains "$(curl -s "$BASE/admin/")" "IpsenGPT admin" "serves the admin app"

step "Chat through the primary (PC tunnel)"
token=$(curl -sf -X POST "$BASE/api/session" -H 'content-type: application/json' -d '{"name":"Kari"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
chat() { curl -sN -X POST "$BASE/api/chat" -H "authorization: Bearer $token" -H 'content-type: application/json' -d "{\"message\":\"$1\"}"; }
assert_contains "$(chat one)" "PRIMARY-REPLY" "reply comes from the primary"

step "Pull the plug on the PC"
kill "$PRIMARY_PID"; wait_for 5 bash -c "! curl -s http://127.0.0.1:$PRIMARY_PORT" || true
assert_contains "$(chat two)" "FALLBACK-REPLY" "reply comes from the fallback"

step "Restart the app container; data must survive"
docker compose -p "$PROJECT" -f docker-compose.yml -f override.yml restart app >/dev/null 2>&1
wait_for 30 curl -sf "$BASE/api/health" || fail "app not healthy after restart"
session=$(curl -sf "$BASE/api/session" -H "authorization: Bearer $token")
assert_contains "$session" '"name":"Kari"' "session survives restart"
assert_contains "$session" "FALLBACK-REPLY" "chat history survives restart"
[[ -f "$WORK/data/db/ipsengpt.sqlite" ]] && pass "database lives in the bind-mounted volume" || fail "no db file on host"

step "Recreate the container (as on deploy)"
docker compose -p "$PROJECT" -f docker-compose.yml -f override.yml up -d --force-recreate >/dev/null 2>&1
wait_for 30 curl -sf "$BASE/api/health" || fail "app not healthy after recreate"
assert_contains "$(curl -sf "$BASE/api/session" -H "authorization: Bearer $token")" '"name":"Kari"' "session survives recreate"

step "Persona edits apply without restart"
echo "You are EditedGhost." > "$WORK/content/persona.md"
docker compose -p "$PROJECT" exec -T app cat /app/content/persona.md | grep -q EditedGhost && pass "content mount is live" || fail "content not mounted"

printf '\n\033[32m%d checks passed\033[0m\n' "$PASS"
