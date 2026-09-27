#!/usr/bin/env bash
set -Eeuo pipefail

SRC=/opt/t3code
LIVE=/home/ubuntu/.t3/selfbuilt/t3code
BACKUP_ROOT=/home/ubuntu/.t3/backups/release-hub-t3code
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_ROOT/$STAMP.tar.gz"
GENERATED="$SRC/.generated/third-party-licenses/spdx/v3.28.0"
T3CTL=(env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user)
PORT=3773

port_owner() {
  ss -Hltnp "sport = :$PORT" | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2
}

# The desktop app's remote-environment launcher can start its own server on
# $PORT while the unit is stopped; the unit then loops on EADDRINUSE and the
# health check below would be answered by the stale process.
free_port() {
  local pid
  for _ in $(seq 1 10); do
    pid=$(port_owner)
    [ -z "$pid" ] && return 0
    kill "$pid" 2>/dev/null || true
    sleep 1
  done
  pid=$(port_owner)
  [ -z "$pid" ] || kill -9 "$pid" 2>/dev/null || true
}

start_unit() {
  "${T3CTL[@]}" stop t3code.service
  free_port
  "${T3CTL[@]}" reset-failed t3code.service 2>/dev/null || true
  "${T3CTL[@]}" start t3code.service
}

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
  rsync -a --delete "$restore/apps/web/dist/" "$LIVE/apps/web/dist/"
  rsync -a --delete "$restore/apps/server/dist/" "$LIVE/apps/server/dist/"
  start_unit
  rm -rf "$restore"
  echo "t3code deployment failed; previous dist restored" >&2
  exit "$rc"
}
trap rollback ERR

rsync -a --delete "$SRC/apps/web/dist/" "$LIVE/apps/web/dist/"
rsync -a --delete "$SRC/apps/server/dist/" "$LIVE/apps/server/dist/"
start_unit

for _ in $(seq 1 90); do
  main_pid=$("${T3CTL[@]}" show -p MainPID --value t3code.service)
  if [ "$main_pid" != "0" ] && [ "$(port_owner)" = "$main_pid" ] &&
    curl --noproxy "*" -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$PORT/"; then
    trap - ERR
    ls -1t "$BACKUP_ROOT"/*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
    echo "t3code deployment healthy"
    exit 0
  fi
  sleep 2
done

echo "t3code did not become healthy within 180 seconds" >&2
false
