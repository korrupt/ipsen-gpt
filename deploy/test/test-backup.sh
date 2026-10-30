#!/usr/bin/env bash
# Runs deploy/droplet/backup.sh in an Ubuntu container (same sqlite3/rsync as the droplet).
source "$(dirname "$0")/lib.sh"

IMAGE=ipsengpt-backup-test
step "Backup script on Ubuntu 24.04"
docker build -q -t "$IMAGE" - >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3 rsync >/dev/null
DOCKERFILE

out=$(docker run --rm -v "$DEPLOY_DIR/droplet:/setup:ro" "$IMAGE" bash -euo pipefail -c '
  export APP_ROOT=/srv/ipsengpt BACKUP_KEEP=2
  mkdir -p $APP_ROOT/db $APP_ROOT/people/ola $APP_ROOT/photos $APP_ROOT/gates
  db=$APP_ROOT/db/ipsengpt.sqlite
  sqlite3 $db "PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);" >/dev/null
  echo "name: Ola" > $APP_ROOT/people/ola/person.md
  echo "[{\"id\":\"hat\"}]" > $APP_ROOT/gates/gates.json
  head -c 100000 /dev/urandom > $APP_ROOT/photos/a.jpg

  # A writer hammering the DB while backups run (the app keeps writing at the party).
  # It waits on locks like the app does (busy_timeout = 5000 in apps/server/src/db.ts).
  ( for i in $(seq 1 3000); do sqlite3 -cmd ".timeout 5000" $db "INSERT INTO t (v) VALUES (\"row$i\")"; done ) &
  writer=$!
  sleep 0.5
  /setup/backup.sh >/dev/null
  first=$(readlink $APP_ROOT/backups/latest)
  echo "integrity=$(sqlite3 $APP_ROOT/backups/$first/ipsengpt.sqlite "PRAGMA integrity_check")"
  echo "rows_gt0=$(( $(sqlite3 $APP_ROOT/backups/$first/ipsengpt.sqlite "SELECT COUNT(*) FROM t") > 0 ))"
  echo "people=$(cat $APP_ROOT/backups/$first/people/ola/person.md)"
  echo "gates=$(cat $APP_ROOT/backups/$first/gates/gates.json)"
  wait $writer

  sleep 1; head -c 1000 /dev/urandom > $APP_ROOT/photos/b.jpg
  /setup/backup.sh >/dev/null
  second=$(readlink $APP_ROOT/backups/latest)
  echo "rows_final=$(sqlite3 $APP_ROOT/backups/$second/ipsengpt.sqlite "SELECT COUNT(*) FROM t")"
  ia=$(stat -c %i $APP_ROOT/backups/$first/photos/a.jpg); ib=$(stat -c %i $APP_ROOT/backups/$second/photos/a.jpg)
  echo "hardlinked=$([[ $ia == "$ib" ]] && echo yes || echo no)"
  echo "new_photo=$([[ -f $APP_ROOT/backups/$second/photos/b.jpg ]] && echo yes || echo no)"

  sleep 1; /setup/backup.sh >/dev/null
  echo "kept=$(find $APP_ROOT/backups -mindepth 1 -maxdepth 1 -type d -name "20*" | wc -l)"
  echo "partial=$(find $APP_ROOT/backups -name "*.partial" | wc -l)"
  echo "first_pruned=$([[ -d $APP_ROOT/backups/$first ]] && echo no || echo yes)"
' 2>&1) || fail "backup run failed: $out"

assert_contains "$out" "integrity=ok" "snapshot taken during writes passes integrity_check"
assert_contains "$out" "rows_gt0=1" "snapshot contains data"
assert_contains "$out" "people=name: Ola" "people folders are backed up"
assert_contains "$out" 'gates=[{"id":"hat"}]' "gates are backed up"
assert_contains "$out" "rows_final=3000" "later backup has every row"
assert_contains "$out" "hardlinked=yes" "unchanged photos are hard-linked, not copied"
assert_contains "$out" "new_photo=yes" "new photos are included"
assert_contains "$out" "kept=2" "retention keeps BACKUP_KEEP backups"
assert_contains "$out" "first_pruned=yes" "oldest backup is pruned"
assert_contains "$out" "partial=0" "no half-written backups left behind"

printf '\n\033[32m%d checks passed\033[0m\n' "$PASS"
