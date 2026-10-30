#!/usr/bin/env bash
# Runs the production compose stack locally with a mock Ollama standing in for
# the PC (reached through the "tunnel" port in production).
source "$(dirname "$0")/lib.sh"

IMAGE_TAG=${IMAGE_TAG:-compose-test}
WORK=$(mktemp -d)
APP_PORT=$(free_port)
PRIMARY_PORT=$(free_port)
PROJECT=ipsengpt-test-$$
PIDS=()

cleanup() {
  (cd "$WORK" && docker compose -p "$PROJECT" down -v >/dev/null 2>&1) || true
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
PRIMARY_PID=${PIDS[0]}

step "Start stack (data in $WORK/data)"
cp "$DEPLOY_DIR/docker-compose.yml" "$WORK/"
mkdir -p "$WORK/data"/{db,people,photos,personas,gates}
cat > "$WORK/.env" <<ENV
IPSENGPT_TAG=$IMAGE_TAG
APP_PORT=$APP_PORT
DATA_ROOT=$WORK/data
OLLAMA_URL=http://127.0.0.1:$PRIMARY_PORT
OLLAMA_MODEL=mock
OLLAMA_CHECK_INTERVAL_MS=500
ADMIN_PASSWORD=compose-test-pw
ENV
cd "$WORK"
docker compose -p "$PROJECT" up -d >/dev/null 2>&1 || fail "compose up"
BASE="http://127.0.0.1:$APP_PORT"
wait_for 30 curl -sf "$BASE/api/health" || { docker compose -p "$PROJECT" logs app; fail "app not healthy"; }
pass "app healthy on 127.0.0.1:$APP_PORT"

listen=$(ss -ltnH "sport = :$APP_PORT" | awk '{print $4}')
assert_eq "$listen" "127.0.0.1:$APP_PORT" "app listens on loopback only"
assert_contains "$(curl -s "$BASE/")" "<title>SadGPT</title>" "serves the guest app"
assert_contains "$(curl -s "$BASE/admin/")" "SadGPT admin" "serves the admin app"

step "Chat through the PC (tunnel)"
token=$(curl -sf -X POST "$BASE/api/session" -H 'content-type: application/json' -d '{"name":"Kari"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
chat() { curl -sN -X POST "$BASE/api/chat" -H "authorization: Bearer $token" -H 'content-type: application/json' -d "{\"message\":\"$1\"}"; }
assert_contains "$(chat one)" "PRIMARY-REPLY" "reply comes from the PC"

step "Pull the plug on the PC"
kill "$PRIMARY_PID"; wait_for 5 bash -c "! curl -s http://127.0.0.1:$PRIMARY_PORT" || true
# Capture first: `chat | grep -q` fails under pipefail when grep exits before curl finishes writing.
closed() { grep -q '"code":"chat_closed"' <<<"$(chat two)"; }
wait_for 5 closed && pass "chat closes within a few seconds" || fail "chat did not close: $(chat two)"
assert_contains "$(chat two)" '"reason":"disconnected","message":"SadGPT' "guests are told why"

step "Plug it back in"
start_mock "$PRIMARY_PORT" "PRIMARY-REPLY"
reopened() { grep -q PRIMARY-REPLY <<<"$(chat three)"; }
wait_for 5 reopened && pass "chat reopens by itself when the PC is back" || fail "chat did not reopen: $(chat three)"

step "Restart the app container; data must survive"
docker compose -p "$PROJECT" restart app >/dev/null 2>&1
wait_for 30 curl -sf "$BASE/api/health" || fail "app not healthy after restart"
session=$(curl -sf "$BASE/api/session" -H "authorization: Bearer $token")
assert_contains "$session" '"name":"Kari"' "session survives restart"
assert_contains "$session" "PRIMARY-REPLY" "chat history survives restart"
[[ -f "$WORK/data/db/ipsengpt.sqlite" ]] && pass "database lives in the bind-mounted volume" || fail "no db file on host"
diff -r "$REPO_ROOT/content/personas" "$WORK/data/personas" >/dev/null \
  && pass "the shipped personas were copied into the empty personas volume" || fail "personas not seeded: $(ls "$WORK/data/personas")"
cmp -s "$REPO_ROOT/content/gates.json" "$WORK/data/gates/gates.json" \
  && pass "the shipped gates were copied into the empty gates volume" || fail "gates not seeded: $(ls "$WORK/data/gates")"
echo '[]' > "$WORK/data/gates/gates.json"
# An edit made in admin (here: by hand, as the app's user would write it).
printf -- '---\nname: Edited\n---\nYou are EditedGhost.\n' > "$WORK/data/personas/sadgpt.md"

step "Recreate the container (as on deploy)"
docker compose -p "$PROJECT" up -d --force-recreate >/dev/null 2>&1
wait_for 30 curl -sf "$BASE/api/health" || fail "app not healthy after recreate"
assert_contains "$(curl -sf "$BASE/api/session" -H "authorization: Bearer $token")" '"name":"Kari"' "session survives recreate"

grep -q EditedGhost "$WORK/data/personas/sadgpt.md" && pass "persona edits survive a recreate (not re-seeded)" || fail "persona edit was overwritten"
[[ "$(cat "$WORK/data/gates/gates.json")" == '[]' ]] && pass "gate edits survive a recreate (not re-seeded)" || fail "gates were re-seeded"

step "Gate edits apply without restart"
echo '[{"id":"x","target":"a hat","guest_prompt":"Show me a hat!","trigger":{"type":"session_start"}}]' > "$WORK/data/gates/gates.json"
assert_contains "$(curl -sf -X POST "$BASE/api/session" -H 'content-type: application/json' -d '{"name":"Per"}')" \
  'Show me a hat!' "the app reads the gates volume live"

printf '\n\033[32m%d checks passed\033[0m\n' "$PASS"
