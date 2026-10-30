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
# Fake sudo for the "remote" side: deploy.sh creates data folders that setup.sh didn't (e.g. personas/).
printf '#!/usr/bin/env bash\n[[ $1 == -n ]] && shift\nexec "$@"\n' > "$WORK/bin/sudo"
chmod +x "$WORK/bin/sudo"

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

# A droplet from before gates moved to the data folder, with a hand-edited gate.
echo '[{"id":"old","target":"an old hat","guest_prompt":"Hat!","trigger":{"type":"admin_forced"}}]' > "$WORK/app/content/gates.json"
cp "$WORK/app/content/gates.json" "$WORK/app/content/old-gates.json"

step "deploy.sh to a fake droplet"
deploy() { PATH="$WORK/bin:$PATH" REMOTE_DIR="$WORK/app" DEPLOY_CONFIG=/nonexistent "$DEPLOY_DIR/deploy.sh" fake-droplet --skip-checks; }
out=$(deploy 2>&1) || fail "deploy failed: $out"
pass "deploy.sh exits 0"
tag=$(grep -oP '^IPSENGPT_TAG=\K.*' "$WORK/app/.env")
assert_contains "$tag" "$(git -C "$REPO_ROOT" rev-parse --short HEAD)" "IPSENGPT_TAG updated to the git revision"
assert_contains "$out" "previous: previous-tag" "reports the previous tag for rollback"
cmp -s "$DEPLOY_DIR/docker-compose.yml" "$WORK/app/docker-compose.yml" && pass "compose file synced" || fail "compose not synced"
[[ ! -e "$WORK/app/content/personas" ]] && pass "personas are not synced (they're edited in admin)" || fail "deploy.sh still syncs personas"
cmp -s "$WORK/app/content/old-gates.json" "$WORK/app/content/gates.json" && pass "gates are not synced (they're edited in admin)" || fail "deploy.sh still syncs gates"
docker image inspect "ipsengpt:$tag" >/dev/null && pass "image loaded via docker save | ssh docker load"

BASE="http://127.0.0.1:$APP_PORT"
token=$(curl -sf -X POST "$BASE/api/session" -H 'content-type: application/json' -d '{"name":"Kari"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
assert_contains "$(curl -sN -X POST "$BASE/api/chat" -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"message":"hi"}')" \
  "PRIMARY-REPLY" "deployed app chats through the PC"

[[ "$(stat -c %u:%a "$WORK/data/personas")" == 1000:750 ]] && pass "deploy.sh creates the personas folder for the app's user" || fail "personas folder: $(stat -c %u:%a "$WORK/data/personas")"
[[ -f "$WORK/data/personas/sadgpt.md" ]] && pass "the shipped personas are copied into the data folder" || fail "personas not seeded"
[[ "$(stat -c %u:%a "$WORK/data/gates")" == 1000:750 ]] && pass "deploy.sh creates the gates folder for the app's user" || fail "gates folder: $(stat -c %u:%a "$WORK/data/gates")"
cmp -s "$WORK/app/content/old-gates.json" "$WORK/data/gates/gates.json" \
  && pass "the droplet's old content/gates.json is carried over, not the shipped one" || fail "old gates not carried over: $(head -c 200 "$WORK/data/gates/gates.json")"

step "Redeploy keeps data"
printf -- '---\nname: Edited\n---\nYou are EditedGhost.\n' > "$WORK/data/personas/sadgpt.md"
echo '[]' > "$WORK/data/gates/gates.json"
out=$(deploy 2>&1) || fail "second deploy failed: $out"
assert_contains "$(curl -sf "$BASE/api/session" -H "authorization: Bearer $token")" '"name":"Kari"' "session survives redeploy"
grep -q EditedGhost "$WORK/data/personas/sadgpt.md" && pass "persona edits survive a redeploy" || fail "redeploy overwrote a persona edit"
[[ "$(cat "$WORK/data/gates/gates.json")" == '[]' ]] && pass "gate edits survive a redeploy" || fail "redeploy overwrote the gates"

step "Refuses to deploy without a .env on the droplet"
mv "$WORK/app/.env" "$WORK/app/.env.bak"
out=$(deploy 2>&1) && fail "deployed without .env" || assert_contains "$out" ".env missing" "clear error without .env"
mv "$WORK/app/.env.bak" "$WORK/app/.env"

printf '\n\033[32m%d checks passed\033[0m\n' "$PASS"
