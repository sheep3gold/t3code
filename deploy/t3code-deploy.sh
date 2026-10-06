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
  # grep exits 1 when nothing is listening (the expected steady state after
  # free_port succeeds); under `set -e -o pipefail` that made every caller of
  # this function — including free_port's own success path — abort the
  # script and trip the ERR rollback trap. `|| true` makes "nobody's
  # listening" a normal empty result instead of a script-ending failure.
  ss -Hltnp "sport = :$PORT" | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2 || true
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
  "${T3CTL[@]}" stop t3code.service || true
  # 停干净再拉起：只要 unit 还可能在带老进程重启（activating/deactivating/
  # reloading）就等；failed 也算停稳，后面 reset-failed 会清掉。
  # 注意不能等 "active"：状态机经过 activating 时会短暂离开 active，
  # 在 systemctl --user 上下文里那种 wait 会卡死 bash（wait4 被不断重启）。
  local waited=0
  while :; do
    case "$("${T3CTL[@]}" show -p ActiveState --value t3code.service)" in
      inactive | failed) break ;;
    esac
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge 60 ]; then
      echo "t3code.service failed to stop within 60s" >&2
      return 1
    fi
  done
  free_port
  "${T3CTL[@]}" reset-failed t3code.service 2>/dev/null || true
  # 同步阻塞 start，由 systemd 自己等到 unit 起来（含 ExecStartPre），
  # 避免在用户总线上用轮询循环；下面的健康检查还会再确认端口。
  "${T3CTL[@]}" start t3code.service
}

cd "$SRC"
install -d -m 0755 "$GENERATED" "$BACKUP_ROOT"
cp "$SRC"/deploy/spdx-cache/v3.28.0/*.json "$GENERATED"/

pnpm install --frozen-lockfile --prefer-offline
# 类型检查不过就不发布：此时还没碰线上文件，release-hub 会停在失败，main 不前进。
# 单线程：多线程的 tsgo 峰值约 5.3G，这台机器内存吃紧；单线程约 3.3G。
(cd apps/server && pnpm exec tsc --noEmit --singleThreaded)
pnpm --dir apps/web run build
pnpm --dir apps/server run build:bundle

test -s "$SRC/apps/web/dist/index.html"
test -s "$SRC/apps/server/dist/bin.mjs"
test -d "$LIVE/apps/web/dist"
test -d "$LIVE/apps/server/dist"

# Keep user-scope skill links in sync before touching the running installation.
python3 "$SRC/deploy/host/install-parent-skills.py"

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
# systemd 用户单元、看门狗与 t3 拦截层都在仓库 deploy/host/ 里。
"$SRC/deploy/host/install-host.sh" all
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
