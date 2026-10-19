#!/usr/bin/env bash
set -Eeuo pipefail

# pnpm can rewrite optional-platform metadata even with --frozen-lockfile.
# Keep release-hub's deployed source identical to its committed drift baseline,
# including when installation fails. Dependency resolution still uses the lock.
lock_backup=$(mktemp)
cp pnpm-lock.yaml "$lock_backup"
restore_lock() {
  local rc=$?
  trap - EXIT
  cp "$lock_backup" pnpm-lock.yaml || rc=1
  rm -f "$lock_backup"
  exit "$rc"
}
trap restore_lock EXIT
CI=true pnpm install --frozen-lockfile --prefer-offline
