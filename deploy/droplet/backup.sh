#!/usr/bin/env bash
# Hourly backup (cron, see setup.sh): a consistent SQLite snapshot plus people/
# and photos/, into $APP_ROOT/backups/<timestamp>/. Unchanged photo files are
# hard-linked to the previous backup, so hourly copies cost almost no space.
set -euo pipefail

APP_ROOT=${APP_ROOT:-/srv/ipsengpt}
DEST_ROOT=${BACKUP_ROOT:-$APP_ROOT/backups}
KEEP=${BACKUP_KEEP:-72}
STAMP=$(date -u +%Y%m%d-%H%M%S)
DEST="$DEST_ROOT/$STAMP"
LATEST="$DEST_ROOT/latest"

mkdir -p "$DEST_ROOT"
tmp="$DEST.partial"
rm -rf "$tmp"
mkdir -p "$tmp"

# sqlite3 .backup is safe while the app is writing (WAL mode). The timeout
# waits out a brief lock (e.g. a checkpoint) instead of failing, like the app does.
if [[ -f $APP_ROOT/db/ipsengpt.sqlite ]]; then
  sqlite3 -cmd '.timeout 5000' "$APP_ROOT/db/ipsengpt.sqlite" ".backup '$tmp/ipsengpt.sqlite'"
  [[ $(sqlite3 "$tmp/ipsengpt.sqlite" 'PRAGMA integrity_check') == ok ]] || { echo "backup failed integrity check" >&2; exit 1; }
fi

for dir in people photos; do
  [[ -d $APP_ROOT/$dir ]] || continue
  link=()
  [[ -d $LATEST/$dir ]] && link=(--link-dest "$LATEST/$dir")
  rsync -a "${link[@]}" "$APP_ROOT/$dir/" "$tmp/$dir/"
done

mv "$tmp" "$DEST"
ln -sfn "$STAMP" "$LATEST"

# Keep the newest $KEEP backups.
mapfile -t old < <(find "$DEST_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | head -n -"$KEEP")
((${#old[@]})) && rm -rf "${old[@]}"

echo "$(date -u +%FT%TZ) backup ok: $DEST ($(du -sh "$DEST" | cut -f1))"
