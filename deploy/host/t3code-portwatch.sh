#!/usr/bin/env bash
# Keeps t3code.service the only T3 server on this host.
#
# The desktop app's remote-environment launch script reuses whatever server
# ~/.t3/userdata/server-runtime.json points at; if that pid is gone it picks
# the first free port from 3773 up and starts its own `t3 serve` there. Any
# second server shares state.sqlite but keeps separate in-memory projections,
# so desktop and mobile (nginx -> 3773) stop seeing each other's messages.
# The `t3` interceptor (deploy/host/t3-launcher.sh) turns those
# launches into a TCP forward to 3773; this timer is the safety net for when
# the unit is down or a stray server slipped in anyway. It also re-installs
# that interceptor when `t3 update` or a desktop upgrade replaces it.
#
# Managed in the repo at deploy/host/; installed by t3code-deploy.
set -Eeuo pipefail

PORT=3773

"$(dirname -- "$0")/install-host.sh" launcher

# Deploys stop/start t3code.service themselves and expect to own the port
# for the duration; don't fight t3code-deploy.service while it's running.
systemctl is-active --quiet t3code-deploy.service && exit 0

port_owner() {
  ss -Hltnp "sport = :$PORT" | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2 || true
}

main_pid=$(systemctl --user show -p MainPID --value t3code.service)
if [ "$main_pid" = "0" ] || [ "$(port_owner)" != "$main_pid" ]; then
  systemctl --user reset-failed t3code.service 2>/dev/null || true
  systemctl --user start t3code.service
  exit 0
fi

# Any other self-built server shares ~/.t3/userdata/state.sqlite but keeps its
# own in-memory projections, so clients on it and on 3773 stop seeing each
# other's messages. Only reap them while the unit is healthy on 3773, and
# only listening processes whose argv is exactly `node <selfbuilt> serve` —
# never match by pattern, which would also hit shells mentioning the path.
SELFBUILT=/home/ubuntu/.t3/selfbuilt/t3code/apps/server/dist/bin.mjs
for pid in $(ss -Hltnp | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  [ "$pid" = "$main_pid" ] && continue
  mapfile -d '' argv </proc/"$pid"/cmdline 2>/dev/null || continue
  [ "${argv[1]:-}" = "$SELFBUILT" ] && [ "${argv[2]:-}" = serve ] || continue
  echo "reaping split-brain T3 server pid=$pid: ${argv[*]}"
  kill "$pid" 2>/dev/null || true
done
