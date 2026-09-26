#!/usr/bin/env bash
set -Eeuo pipefail

SRC=/opt/t3code
LIVE=/home/ubuntu/.t3/selfbuilt/t3code
BACKUP_ROOT=/home/ubuntu/.t3/backups/release-hub-t3code
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_ROOT/$STAMP.tar.gz"
GENERATED="$SRC/.generated/third-party-licenses/spdx/v3.28.0"
T3CTL=(env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user)

cd "$SRC"
install -d -m 0755 "$GENERATED" "$BACKUP_ROOT"
cp "$SRC"/deploy/spdx-cache/v3.28.0/*.json "$GENERATED"/

pnpm install --frozen-lockfile --prefer-offline
pnpm --dir apps/web run build
pnpm --dir apps/server run build:bundle

test -s "$SRC/apps/web/dist/index.html"
test -s "$SRC/apps/server/dist/bin.mjs"
test -d "$LIVE/apps/web/dist"
test -d "$LIVE/apps/server/dist"

tar czf "$BACKUP" -C "$LIVE" apps/web/dist apps/server/dist

rollback() {
  rc=$?
  trap - ERR
  set +e
  restore=$(mktemp -d "$BACKUP_ROOT/restore.XXXXXX")
  tar xzf "$BACKUP" -C "$restore"
  "${T3CTL[@]}" stop t3code.service
  rsync -a --delete "$restore/apps/web/dist/" "$LIVE/apps/web/dist/"
  rsync -a --delete "$restore/apps/server/dist/" "$LIVE/apps/server/dist/"
  "${T3CTL[@]}" start t3code.service
  rm -rf "$restore"
  echo "t3code deployment failed; previous dist restored" >&2
  exit "$rc"
}
trap rollback ERR

"${T3CTL[@]}" stop t3code.service
rsync -a --delete "$SRC/apps/web/dist/" "$LIVE/apps/web/dist/"
rsync -a --delete "$SRC/apps/server/dist/" "$LIVE/apps/server/dist/"
"${T3CTL[@]}" start t3code.service

for _ in $(seq 1 90); do
  if curl --noproxy "*" -fsS --max-time 3 -o /dev/null http://127.0.0.1:3773/; then
    trap - ERR
    ls -1t "$BACKUP_ROOT"/*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
    echo "t3code deployment healthy"
    exit 0
  fi
  sleep 2
done

echo "t3code did not become healthy within 180 seconds" >&2
false
